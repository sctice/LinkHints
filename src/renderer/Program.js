// @flow

import {
  Resets,
  TimeTracker,
  type Viewport,
  addEventListener,
  addListener,
  bind,
  getViewport,
  log,
  setStyles,
  unreachable,
  waitForPaint,
} from "../shared/main";
import type { Box } from "../worker/ElementManager";
import type {
  ElementWithHint,
  FromBackground,
  FromRenderer,
  HintUpdate,
  ToBackground,
} from "../data/Messages";

import { type Rule, applyStyles, parseCSS } from "./css";

// It's tempting to put a random number or something in the ID, but in case
// something goes wrong and a rogue container is left behind it's always
// possible to find and remove it if the ID is known.
const CONTAINER_ID = "__SynthWebExt";
const HINT_CLASS = "hint";
const HIDDEN_HINT_CLASS = "hidden";
const HIGHLIGHTED_HINT_CLASS = "highlighted";
const MATCHED_CHARS_CLASS = "matchedChars";
const TEXT_RECT_CLASS = "matchedText";
const TITLE_CLASS = "title";

const MAX_IMMEDIATE_HINT_MOVEMENTS = 50;
const UNRENDER_DELAY = 200; // ms

// The minimum and maximum z-index browsers support.
const MIN_Z_INDEX = -2147483648;
const MAX_Z_INDEX = 2147483647;

const CONTAINER_STYLES = {
  all: "unset",
  position: "fixed",
  "z-index": String(MAX_Z_INDEX),
  "pointer-events": "none",
  overflow: "hidden",
};

const font = BROWSER === "firefox" ? "font: menu;" : "font-family: system-ui;";

const CSS = `
.${HINT_CLASS} {
  position: absolute;
  transform: translateY(-50%);
  box-sizing: border-box;
  padding: 2px;
  border: solid 1px rgba(0, 0, 0, 0.5);
  ${
    "" // This is the yellow used in Chrome for findbar matches.
  }
  background-color: #f6ff00;
  color: black;
  ${font}
  font-size: 12px;
  line-height: 1;
  font-weight: bold;
  white-space: nowrap;
  text-align: center;
  text-transform: uppercase;
}

.${HIDDEN_HINT_CLASS} {
  opacity: 0;
}

.${HIGHLIGHTED_HINT_CLASS} {
  background-color: lime;
}

.${MATCHED_CHARS_CLASS} {
  opacity: 0.3;
}

.${TEXT_RECT_CLASS} {
  position: absolute;
  z-index: ${MIN_Z_INDEX};
  box-sizing: border-box;
  ${
    "" // This is the purple used in Firefox for findbar "Highlight all" matches.
  }
  border-bottom: 2px solid #ef0fff;
}

.${TITLE_CLASS} {
  box-sizing: border-box;
  position: absolute;
  z-index: ${MAX_Z_INDEX};
  bottom: 0;
  right: 0;
  max-width: 100%;
  padding: 4px 6px;
  box-shadow: 0 0 1px 0 rgba(255, 255, 255, 0.5);
  background-color: black;
  color: white;
  ${font}
  font-size: 14px;
  line-height: 1;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
`.trim();

export default class RendererProgram {
  css: string;
  parsedCSS: ?Array<Rule>;
  hints: Array<HTMLElement>;
  rects: Map<HTMLElement, ClientRect>;
  unrenderTimeoutId: ?TimeoutID;
  enteredTextChars: string;
  resets: Resets;
  shruggieElement: HTMLElement;
  titleElement: HTMLElement;
  container: {|
    element: HTMLElement,
    root: ShadowRoot,
    resets: Resets,
    intersectionObserver: IntersectionObserver,
  |};

  constructor() {
    this.css = CSS;
    this.parsedCSS = undefined;
    this.hints = [];
    this.rects = new Map();
    this.unrenderTimeoutId = undefined;
    this.enteredTextChars = "";
    this.resets = new Resets();

    bind(this, [
      [this.onMessage, { catch: true }],
      [this.sendMessage, { catch: true }],
      [this.start, { catch: true }],
      [this.stop, { log: true, catch: true }],
      [this.render, { catch: true }],
      this.onIntersection,
      this.onResize,
    ]);

    this.shruggieElement = createHintElement("¯\\_(ツ)_/¯");
    setStyles(this.shruggieElement, {
      top: "50%",
      left: "50%",
      transform: "translate(-50%, -50%)",
    });

    this.titleElement = document.createElement("div");
    this.titleElement.className = TITLE_CLASS;

    const container = document.createElement("div");
    container.id = CONTAINER_ID;
    setStyles(container, CONTAINER_STYLES);

    // Using `mode: "closed"` is tempting, but then Firefox does not seem to
    // allow inspecting the elements inside in its devtools. That's important
    // for people who want to customize the styling of the hints.
    const root = container.attachShadow({ mode: "open" });

    this.container = {
      element: container,
      root,
      resets: new Resets(),
      intersectionObserver: new IntersectionObserver(this.onIntersection, {
        // Make sure the container stays within the viewport.
        threshold: 1,
      }),
    };
  }

  async start(): Promise<void> {
    // This is useful during development. If reloading the extension during
    // hints mode, the old hints will be removed as soon as the new version
    // starts.
    this.unrender();

    this.resets.add(addListener(browser.runtime.onMessage, this.onMessage));

    try {
      // Don’t use `this.sendMessage` since it automatically catches and logs
      // errors.
      await browser.runtime.sendMessage(
        wrapMessage({ type: "RendererScriptAdded" })
      );
    } catch (_error) {
      // In Firefox, content scripts are loaded automatically in already
      // existing tabs. (Chrome only automatically loads content scripts into
      // _new_ tabs.) The content scripts run before the background scripts, so
      // this message can fail since there’s nobody listening on the other end.
      // Instead, the background script will send the "FirefoxWorkaround"
      // message to all existing tabs when it starts, allowing us to retry
      // sending "RendererScriptAdded" at that point. See: <bugzil.la/1474727>

      // Don’t set up the port below, since it will just immediately disconnect
      // (since the background script isn’t ready to connect yet). That would
      // cause `this.stop()` to be called, but we actually want to continue
      // running. As mentioned below, WebExtensions can’t really run any cleanup
      // logic in Firefox anyway.
      return;
    }

    // In Chrome, content scripts continue to live after the extension has been
    // disabled, uninstalled or reloaded. A way to detect this is to make a
    // `Port` and listen for `onDisconnect`. Then one can run some cleanup to
    // make the effectively disable the script.
    // In Firefox, content scripts are nuked when uninstalling. `onDisconnect`
    // never runs. Hopefully this changes some day, since we’d ideally want to
    // clean up injected.js. There does not seem to be any good way of running
    // cleanups when a WebExtension is disabled in Firefox. See:
    // <bugzil.la/1223425>
    browser.runtime.connect().onDisconnect.addListener(() => {
      this.stop();
    });
  }

  stop() {
    this.resets.reset();
    this.unrender();
  }

  async sendMessage(message: FromRenderer): Promise<void> {
    log("log", "RendererProgram#sendMessage", message.type, message);
    await browser.runtime.sendMessage(wrapMessage(message));
  }

  onMessage(wrappedMessage: FromBackground) {
    // As mentioned in `this.start`, re-send the "RendererScriptAdded" message
    // in Firefox as a workaround for its content script loading quirks.
    if (wrappedMessage.type === "FirefoxWorkaround") {
      this.sendMessage({ type: "RendererScriptAdded" });
      return;
    }

    if (wrappedMessage.type !== "ToRenderer") {
      return;
    }

    const { message } = wrappedMessage;

    log("log", "RendererProgram#onMessage", message.type, message);

    switch (message.type) {
      case "StateSync":
        log.level = message.logLevel;
        break;

      case "Render":
        this.render(message.elements);
        break;

      case "UpdateHints":
        this.updateHints(message.updates, message.enteredTextChars);
        break;

      case "RotateHints":
        this.rotateHints({ forward: message.forward });
        break;

      case "RenderTextRects":
        this.unrenderTextRects(message.frameId);
        this.renderTextRects(message.rects, message.frameId);
        break;

      case "UnrenderTextRects":
        this.unrenderTextRects();
        break;

      case "Unrender":
        switch (message.mode.type) {
          case "immediate":
            this.unrender();
            break;
          case "delayed":
            this.unrenderDelayed();
            break;
          case "title":
            this.unrenderToTitle(message.mode.title);
            break;
          default:
            unreachable(message.mode.type, message);
        }
        break;

      default:
        unreachable(message.type, message);
    }
  }

  onIntersection(entries: Array<IntersectionObserverEntry>) {
    // There will only be one entry.
    const entry = entries[0];
    if (entry.intersectionRatio !== 1) {
      requestAnimationFrame(() => {
        this.updateContainer(
          // `entry.rootBounds` is supposed to be the viewport size, but I've
          // noticed it being way larger in Chrome sometimes, so calculate it
          // manually there.
          BROWSER === "chrome" ? getViewport() : entry.rootBounds
        );
      });
    }
  }

  onResize() {
    this.updateContainer(getViewport());
  }

  updateContainer(viewport: { width: number, height: number }) {
    const container = this.container.element;

    setStyles(container, {
      left: "0",
      top: "0",
      width: `${viewport.width}px`,
      height: `${viewport.height}px`,
    });

    // If the `<html>` element has `transform: translate(...);` (some sites push
    // the entire page to the side when opening a sidebar menu using this
    // technique) we need to take that into account.
    const rect = container.getBoundingClientRect();
    if (rect.left !== 0) {
      setStyles(container, { left: `${-rect.left}px` });
    }
    if (rect.top !== 0) {
      setStyles(container, { top: `${-rect.top}px` });
    }
  }

  async render(elements: Array<ElementWithHint>): Promise<void> {
    const { documentElement } = document;

    if (documentElement == null) {
      return;
    }

    const time = new TimeTracker();

    time.start("prepare");
    this.unrender();
    const viewport = getViewport();
    const { root } = this.container;

    if (this.parsedCSS == null) {
      // Inserting a `<style>` element is way faster than doing
      // `element.style.setProperty()` on every element.
      const style = document.createElement("style");
      style.append(document.createTextNode(this.css));
      root.append(style);

      // Chrome nicely allows inline styles inserted by an extension regardless
      // of CSP. I look forward to the day Firefox works this way too. See
      // <bugzil.la/1267027>. If `style.sheet` is null in Firefox (it is always
      // null in Chrome), it means that the style tag was blocked by CSP. Unlike
      // the case with the script tag in ElementManager.js, a data URI (`<link
      // rel="stylesheet" href="data:text/css;utf8,...">`) does not work here
      // (it causes no CSP warning in the console, but no styles are applied).
      // The only workaround I could find was manually parsing and applying the
      // CSS.
      if (BROWSER === "firefox" && style.sheet == null) {
        this.parsedCSS = parseCSS(this.css);
      }
    }

    documentElement.append(this.container.element);
    this.updateContainer(viewport);
    this.container.intersectionObserver.observe(this.container.element);
    this.container.resets.add(
      addEventListener(window, "resize", this.onResize),
      addEventListener(window, "underflow", this.onResize)
    );

    if (elements.length === 0) {
      this.insertShruggie();
      return;
    }

    // "W" is usually (one of) the widest character(s). This is surprisingly
    // cheap to calculate.
    const probe1 = createHintElement("W");
    const probe2 = createHintElement("WW");
    root.append(probe1);
    root.append(probe2);
    this.maybeApplyStyles(probe1);
    this.maybeApplyStyles(probe2);
    const rect1 = probe1.getBoundingClientRect();
    const rect2 = probe2.getBoundingClientRect();
    const halfHeight = Math.ceil(rect1.height / 2);
    const widthK = rect2.width - rect1.width;
    const widthM = rect1.width - widthK;
    probe1.remove();
    probe2.remove();

    const edgeElements = [];
    const restElements = [];
    let numEdgeElements = 0;

    time.start("loop");
    for (const [index, { hintMeasurements, hint }] of elements.entries()) {
      const element = createHintElement(hint);

      const width = Math.ceil(widthM + widthK * hint.length);

      const alignLeft =
        hintMeasurements.align === "left" &&
        // If the hint would end up covering the element, align right instead.
        // This is useful for the tiny voting arrows on hackernews.
        hintMeasurements.x + width < hintMeasurements.maxX;

      const styles = {
        left: alignLeft ? `${Math.round(hintMeasurements.x)}px` : "",
        // This could also be done using `left` and
        // `transform: translateX(-100%)`, but that results in blurry hints in
        // Chrome due to Chrome making the widths of the hints non-integer based
        // on the font.
        right: alignLeft
          ? ""
          : `${Math.round(viewport.width - hintMeasurements.x)}px`,
        top: `${Math.round(hintMeasurements.y)}px`,
        "z-index": String(MAX_Z_INDEX - index),
      };
      setStyles(element, styles);

      root.append(element);
      this.hints.push(element);

      this.maybeApplyStyles(element);

      const outsideHorizontally =
        hintMeasurements.align === "left"
          ? viewport.width - hintMeasurements.x <= width
          : hintMeasurements.x <= width;

      const outsideVertically =
        hintMeasurements.y <= halfHeight ||
        viewport.height - hintMeasurements.y <= halfHeight;

      if (
        numEdgeElements < MAX_IMMEDIATE_HINT_MOVEMENTS &&
        (outsideHorizontally || outsideVertically)
      ) {
        numEdgeElements = edgeElements.push(element);
      } else {
        restElements.push(element);
      }
    }

    // Most hints are already correctly positioned, but some near the edges
    // might need to be moved a tiny bit to avoid being partially off-screen.
    // Do this in a separate animation frame if there are a lot of hints so
    // that the hints appear on screen as quickly as possible. Adjusting
    // positions is just a tweak – that can be delayed a little bit.
    time.start("move inside 1");
    if (numEdgeElements > 0) {
      this.moveInsideViewport(edgeElements, viewport);
    }

    time.start("paint 1");
    await waitForPaint();

    const firstPaintTimestamp = performance.now();

    time.start("move inside 2");
    const moved = this.moveInsideViewport(restElements, viewport);

    // Only measure the next paint if we actually moved any hints inside the
    // viewport during the second round. This makes the performance report more
    // relevant.
    time.start("paint 2");
    if (moved) {
      await waitForPaint();
    }

    this.sendMessage({
      type: "Rendered",
      firstPaintTimestamp,
      durations: time.export(),
    });
  }

  updateHints(updates: Array<HintUpdate>, enteredTextChars: string) {
    let numHidden = 0;
    const maybeNeedsMoveInsideViewport = [];

    for (const update of updates) {
      const child = this.hints[update.index];

      if (child == null) {
        log("error", "RendererProgram#updateHints: missing child", update);
        continue;
      }

      child.classList.toggle(HIDDEN_HINT_CLASS, update.type === "Hide");

      switch (update.type) {
        case "Hide":
          numHidden++;
          break;

        case "Update":
          emptyNode(child);
          if (update.matchedChars !== "") {
            const matched = document.createElement("span");
            matched.className = MATCHED_CHARS_CLASS;
            matched.append(document.createTextNode(update.matchedChars));
            child.append(matched);
            this.maybeApplyStyles(matched);
          } else if (enteredTextChars !== this.enteredTextChars) {
            setStyles(child, { "margin-right": "", "margin-top": "" });
            maybeNeedsMoveInsideViewport.push(child);
          }
          child.classList.toggle(HIGHLIGHTED_HINT_CLASS, update.highlighted);
          child.append(document.createTextNode(update.restChars));
          break;

        default:
          unreachable(update.type, update);
      }

      this.maybeApplyStyles(child);
    }

    if (numHidden === this.hints.length) {
      this.insertShruggie();
    } else {
      this.removeShruggie();
    }

    if (enteredTextChars === "") {
      this.removeTitle();
    } else {
      this.insertTitle(enteredTextChars.replace(/\s/g, "\u00a0"));
    }

    if (maybeNeedsMoveInsideViewport.length > 0) {
      const viewport = getViewport();
      this.moveInsideViewport(maybeNeedsMoveInsideViewport, viewport);
    }

    this.enteredTextChars = enteredTextChars;
  }

  rotateHints({ forward }: {| forward: boolean |}) {
    const sign = forward ? 1 : +1;
    const stacks = getStacks(this.hints, this.rects);
    for (const stack of stacks) {
      if (stack.length >= 2) {
        // All `z-index`:es are unique, so there’s no need for a stable sort.
        stack.sort(
          (a, b) => (Number(a.style.zIndex) - Number(b.style.zIndex)) * sign
        );
        const [first, ...rest] = stack.map(element => element.style.zIndex);
        const zIndexes = [...rest, first];
        for (const [index, element] of stack.entries()) {
          setStyles(element, { "z-index": zIndexes[index] });
        }
      }
    }
  }

  renderTextRects(rects: Array<Box>, frameId: number) {
    const { root } = this.container;
    for (const rect of rects) {
      const element = document.createElement("div");
      element.className = TEXT_RECT_CLASS;
      element.setAttribute("data-frame-id", String(frameId));
      setStyles(element, {
        left: `${rect.x}px`,
        top: `${rect.y}px`,
        width: `${rect.width}px`,
        height: `${rect.height}px`,
      });
      root.append(element);
    }
  }

  insertShruggie() {
    this.container.root.append(this.shruggieElement);
    this.maybeApplyStyles(this.shruggieElement);
  }

  removeShruggie() {
    this.shruggieElement.remove();
  }

  insertTitle(title: string) {
    this.titleElement.textContent = title;
    this.container.root.append(this.titleElement);
    this.maybeApplyStyles(this.titleElement);
  }

  removeTitle() {
    this.titleElement.remove();
  }

  unrender() {
    if (this.unrenderTimeoutId != null) {
      clearTimeout(this.unrenderTimeoutId);
      this.unrenderTimeoutId = undefined;
    }

    this.hints = [];
    this.rects.clear();

    this.container.element.remove();
    emptyNode(this.container.root);
    this.container.resets.reset();
    this.container.intersectionObserver.disconnect();

    // In theory there can be several left-over elements with `id=CONTAINER_ID`.
    // `querySelectorAll` finds them all.
    const containers = document.querySelectorAll(`#${CONTAINER_ID}`);
    for (const container of containers) {
      container.remove();
    }
  }

  unrenderDelayed() {
    if (this.unrenderTimeoutId != null) {
      return;
    }

    this.unrenderTimeoutId = setTimeout(() => {
      this.unrenderTimeoutId = undefined;
      this.unrender();
    }, UNRENDER_DELAY);
  }

  unrenderToTitle(title: string) {
    if (this.unrenderTimeoutId != null) {
      clearTimeout(this.unrenderTimeoutId);
    }

    this.insertTitle(title);

    this.unrenderTimeoutId = setTimeout(() => {
      this.unrenderTimeoutId = undefined;
      for (const element of this.hints) {
        element.remove();
      }
      this.unrenderTextRects();
      this.hints = [];
      this.rects.clear();
    }, UNRENDER_DELAY);
  }

  unrenderTextRects(frameId?: number) {
    const selector =
      frameId == null
        ? `.${TEXT_RECT_CLASS}`
        : `.${TEXT_RECT_CLASS}[data-frame-id="${frameId}"]`;
    for (const element of this.container.root.querySelectorAll(selector)) {
      element.remove();
    }
  }

  // It’s important to use `setStyles` instead of `.style.foo =` in this file,
  // since `applyStyles` could override inline styles otherwise.
  maybeApplyStyles(element: HTMLElement) {
    if (BROWSER === "firefox" && this.parsedCSS != null) {
      applyStyles(element, this.parsedCSS);
    }
  }

  moveInsideViewport(
    elements: Array<HTMLElement>,
    viewport: Viewport
  ): boolean {
    let moved = false;

    for (const element of elements) {
      const rect = element.getBoundingClientRect();

      // Save the rect for `rotateHints`.
      this.rects.set(element, rect);

      if (rect.left < 0) {
        setStyles(element, { "margin-right": `${Math.round(rect.left)}px` });
        moved = true;
      }
      if (rect.top < 0) {
        setStyles(element, { "margin-top": `${Math.round(-rect.top)}px` });
        moved = true;
      }
      if (rect.right > viewport.width) {
        setStyles(element, {
          "margin-right": `${Math.round(rect.right - viewport.width)}px`,
        });
        moved = true;
      }
      if (rect.bottom > viewport.height) {
        setStyles(element, {
          "margin-top": `${Math.round(viewport.height - rect.bottom)}px`,
        });
        moved = true;
      }
    }

    return moved;
  }
}

function wrapMessage(message: FromRenderer): ToBackground {
  return {
    type: "FromRenderer",
    message,
  };
}

function emptyNode(node: Node) {
  while (node.firstChild != null) {
    node.removeChild(node.firstChild);
  }
}

function createHintElement(hint: string): HTMLElement {
  const element = document.createElement("div");
  element.className = HINT_CLASS;
  element.append(document.createTextNode(hint));
  return element;
}

function getStacks(
  originalElements: Array<HTMLElement>,
  rects: Map<HTMLElement, ClientRect>
): Array<Array<HTMLElement>> {
  // `elements` will be mutated and eventually empty.
  const elements = originalElements.slice();
  const stacks = [];

  while (elements.length > 0) {
    stacks.push(getStackFor(elements.pop(), elements, rects));
  }

  return stacks;
}

// Get an array containing `element` and all elements that overlap `element`, if
// any, which is called a "stack". All elements in the returned stack are spliced
// out from `elements`, thus mutating it.
function getStackFor(
  element: HTMLElement,
  elements: Array<HTMLElement>,
  rects: Map<HTMLElement, ClientRect>
): Array<HTMLElement> {
  const stack = [element];

  let index = 0;
  while (index < elements.length) {
    const nextElement = elements[index];

    // In practice, `rects` will already contain all rects needed (since all
    // hint elements are run through `moveInsideViewport`), so
    // `.getBoundingClientRect()` never hits here. That is a major performance
    // boost.
    const rect = rects.get(element) || element.getBoundingClientRect();
    const nextRect =
      rects.get(nextElement) || nextElement.getBoundingClientRect();

    if (overlaps(nextRect, rect)) {
      // Also get all elements overlapping this one.
      elements.splice(index, 1);
      stack.push(...getStackFor(nextElement, elements, rects));
    } else {
      // Continue the search.
      index += 1;
    }
  }

  return stack;
}

function overlaps(rectA: ClientRect, rectB: ClientRect): boolean {
  return (
    rectA.right >= rectB.left &&
    rectA.left <= rectB.right &&
    rectA.bottom >= rectB.top &&
    rectA.top <= rectB.bottom
  );
}
