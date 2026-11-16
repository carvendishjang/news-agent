// Entry point for LangGraph Studio / `langgraphjs dev` (see langgraph.json).
import "dotenv/config";
import { loadConfig } from "../config.js";
import { createDefaultDeps } from "../agent.js";
import { buildNewsGraph } from "./build.js";

export const graph = buildNewsGraph(createDefaultDeps(loadConfig()));
