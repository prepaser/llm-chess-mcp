import * as z from "zod/v4";

export const GAME_ID_MAX_LENGTH = 256;
export const GameIdSchema = z.string().min(1).max(GAME_ID_MAX_LENGTH);
