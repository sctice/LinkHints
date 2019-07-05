// @flow strict-local

import {
  type Decoder,
  array,
  autoRecord,
  record,
  repr,
  string,
} from "tiny-decoders";

import { type ElementTypes, decodeElementTypes } from "../shared/hints";
import { type Box, decodeUnsignedFloat } from "../shared/main";

export type FrameMessage =
  | {|
      type: "FindElements",
      token: string,
      types: ElementTypes,
      viewports: Array<Box>,
    |}
  | {|
      type: "UpdateElements",
      token: string,
      viewports: Array<Box>,
    |};

export const decodeFrameMessage: Decoder<FrameMessage> = record(
  (field, fieldError) => {
    const type = field("type", string);

    switch (type) {
      case "FindElements":
        return {
          type: "FindElements",
          token: "",
          types: field("types", decodeElementTypes),
          viewports: field("viewports", decodeViewports),
        };

      case "UpdateElements":
        return {
          type: "UpdateElements",
          token: "",
          viewports: field("viewports", decodeViewports),
        };

      default:
        throw fieldError("type", `Unknown FrameMessage type: ${repr(type)}`);
    }
  }
);

const decodeViewports: Decoder<Array<Box>> = array(
  autoRecord({
    x: decodeUnsignedFloat,
    y: decodeUnsignedFloat,
    width: decodeUnsignedFloat,
    height: decodeUnsignedFloat,
  })
);
