/**
 * Shared PrismLight setup — single source of truth for syntax highlighting.
 * Both Markdown.tsx and FileDiffCard.tsx import from here to avoid
 * duplicate language registration.
 */
import { PrismLight } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";

import javascript from "react-syntax-highlighter/dist/esm/languages/prism/javascript";
import typescript from "react-syntax-highlighter/dist/esm/languages/prism/typescript";
import tsx from "react-syntax-highlighter/dist/esm/languages/prism/tsx";
import python from "react-syntax-highlighter/dist/esm/languages/prism/python";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import json from "react-syntax-highlighter/dist/esm/languages/prism/json";
import css from "react-syntax-highlighter/dist/esm/languages/prism/css";
import markdown from "react-syntax-highlighter/dist/esm/languages/prism/markdown";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import docker from "react-syntax-highlighter/dist/esm/languages/prism/docker";

PrismLight.registerLanguage("javascript", javascript);
PrismLight.registerLanguage("js", javascript);
PrismLight.registerLanguage("typescript", typescript);
PrismLight.registerLanguage("ts", typescript);
PrismLight.registerLanguage("tsx", tsx);
PrismLight.registerLanguage("python", python);
PrismLight.registerLanguage("bash", bash);
PrismLight.registerLanguage("sh", bash);
PrismLight.registerLanguage("shell", bash);
PrismLight.registerLanguage("json", json);
PrismLight.registerLanguage("css", css);
PrismLight.registerLanguage("markdown", markdown);
PrismLight.registerLanguage("md", markdown);
PrismLight.registerLanguage("yaml", yaml);
PrismLight.registerLanguage("yml", yaml);
PrismLight.registerLanguage("docker", docker);
PrismLight.registerLanguage("dockerfile", docker);

export { PrismLight, oneDark };

const EXT_TO_LANG: Record<string, string> = {
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  ts: "typescript",
  tsx: "tsx",
  py: "python",
  sh: "bash",
  json: "json",
  css: "css",
  md: "markdown",
  yaml: "yaml",
  yml: "yaml",
};

/** Map a file path to a PrismLight language name. */
export function detectLanguage(filePath: string): string {
  const basename = filePath.split("/").pop() ?? "";
  if (basename === "Dockerfile" || basename.startsWith("Dockerfile.")) return "docker";
  const ext = basename.split(".").pop()?.toLowerCase() ?? "";
  return EXT_TO_LANG[ext] ?? "text";
}
