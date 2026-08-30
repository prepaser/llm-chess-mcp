import * as z from "zod/v4";
import { unicodeLength } from "./string-length.js";

export const GAME_ID_MAX_LENGTH = 256;
export const GameIdSchema = z
  .string()
  .superRefine((value, ctx) => {
    const length = unicodeLength(value);
    if (length < 1 || length > GAME_ID_MAX_LENGTH) {
      ctx.addIssue({
        code: "custom",
        message: `game_id must contain between 1 and ${GAME_ID_MAX_LENGTH} Unicode code points`,
      });
    }
  })
  .meta({ minLength: 1, maxLength: GAME_ID_MAX_LENGTH });
