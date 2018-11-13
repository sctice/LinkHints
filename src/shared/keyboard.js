// @flow strict-local

export type KeyboardAction =
  | {|
      type: "EnterHintsMode",
      mode: HintsMode,
    |}
  | {|
      type: "ExitHintsMode",
    |}
  | {|
      type: "RotateHints",
      forward: boolean,
    |}
  | {|
      type: "RefreshHints",
    |}
  | {|
      type: "Escape",
    |}
  | {|
      type: "ReverseSelection",
    |};

// Raw values from a `KeyboardEvent` that we care about.
export type Keypress = {|
  key: string,
  code: string,
  alt: boolean,
  cmd: boolean,
  ctrl: boolean,
  shift: boolean,
|};

// A `Keypress` after taking “Ignore keyboard layout” into account.
export type NormalizedKeypress = {|
  key: string,
  alt: boolean,
  cmd: boolean,
  ctrl: boolean,
  // If missing it means that the shift key doesn’t matter. For example, it
  // doesn’t matter if you need to press shift to type a `/` or not (which
  // differs between keyboard layouts).
  shift: ?boolean,
|};

export type KeyboardMapping = {|
  keypress: Keypress,
  action: KeyboardAction,
|};

export type KeyboardMode = "Normal" | "Hints" | "PreventOverTyping";

export type HintsMode =
  | "Click"
  | "ManyClick"
  | "ManyTab"
  | "BackgroundTab"
  | "ForegroundTab"
  | "Select";

const EN_US_QWERTY_TRANSLATIONS: Map<string, [string, string]> = new Map([
  ["Backquote", ["`", "~"]],
  ["Digit1", ["1", "!"]],
  ["Digit2", ["2", "@"]],
  ["Digit3", ["3", "#"]],
  ["Digit4", ["4", "$"]],
  ["Digit5", ["5", "%"]],
  ["Digit6", ["6", "^"]],
  ["Digit7", ["7", "&"]],
  ["Digit8", ["8", "*"]],
  ["Digit9", ["9", "("]],
  ["Digit0", ["0", ")"]],
  ["Minus", ["-", "_"]],
  ["Equal", ["=", "+"]],
  ["Backslash", ["\\", "|"]],
  ["BracketLeft", ["[", "{"]],
  ["BracketRight", ["]", "}"]],
  ["Semicolon", [";", ":"]],
  ["Quote", ["'", '"']],
  ["Comma", [",", "<"]],
  ["Period", [".", ">"]],
  ["Slash", ["/", "?"]],
]);

export function keyboardEventToKeypress(event: KeyboardEvent): Keypress {
  return {
    key: event.key,
    code: event.code,
    alt: event.altKey,
    cmd: event.metaKey,
    ctrl: event.ctrlKey,
    shift: event.shiftKey,
  };
}

export function normalizeKeypress({
  keypress,
  ignoreKeyboardLayout,
}: {|
  keypress: Keypress,
  ignoreKeyboardLayout: boolean,
|}): NormalizedKeypress {
  const rawKey =
    // Use `.key` for numpad keys because it is too much work detecting and
    // emulating NumLock.
    ignoreKeyboardLayout && !keypress.code.startsWith("Numpad")
      ? codeToEnUsQwerty({
          code: keypress.code,
          shift: keypress.shift,
        })
      : keypress.key;

  // Consider Space a non-printable key. Easier to see and allows for shift.
  const key = rawKey === " " ? "Space" : rawKey;

  return {
    key,
    alt: keypress.alt,
    cmd: keypress.cmd,
    ctrl: keypress.ctrl,
    shift: key.length === 1 ? undefined : keypress.shift,
  };
}

function codeToEnUsQwerty({
  code,
  shift,
}: {|
  code: string,
  shift: boolean,
|}): string {
  // KeyA–KeyZ
  if (code.startsWith("Key")) {
    const sliced = code.slice(3);
    return shift ? sliced : sliced.toLowerCase();
  }

  const translation = EN_US_QWERTY_TRANSLATIONS.get(code);
  if (translation == null) {
    return code;
  }

  const [unshifted, shifted] = translation;
  return shift ? shifted : unshifted;
}