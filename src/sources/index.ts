import type { StatusSource } from "../domain/ports.ts";
import type { SourceKind } from "../domain/types.ts";
import { aws } from "./aws.ts";
import { betterstack } from "./betterstack.ts";
import { feed } from "./feed.ts";
import { google } from "./google.ts";
import { heroku } from "./heroku.ts";
import { instatus } from "./instatus.ts";
import { probe } from "./probe.ts";
import { railway } from "./railway.ts";
import { slack } from "./slack.ts";
import { statusio } from "./statusio.ts";
import { statuspage } from "./statuspage.ts";

export const sources: Record<SourceKind, StatusSource> = {
  statuspage,
  statusio,
  instatus,
  betterstack,
  google,
  aws,
  feed,
  railway,
  slack,
  heroku,
  probe,
};
