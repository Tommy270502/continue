import { describe, expect, it } from "vitest";
import { getTemplateForModel } from "./AutocompleteTemplate";

function render(model: string): string {
  const template = getTemplateForModel(model).template;
  return typeof template === "string"
    ? template
    : template("PRE", "SUF", "file.ts", "repo", "typescript", [], []);
}

describe("getTemplateForModel - Qwen", () => {
  it.each([
    "qwen2.5-coder:7b",
    "Qwen3-Coder-30B-A3B-Instruct",
    "qwen3.8-27b",
    "qwen3.5-35b-a3b",
    "Qwen3-32B-Q4_K_M",
    "qwen2-7b-instruct",
  ])("uses <|fim_*|> tokens for %s", (model) => {
    const rendered = render(model);
    expect(rendered).toContain("<|fim_prefix|>");
    expect(rendered).toContain("<|fim_suffix|>");
    expect(rendered).toContain("<|fim_middle|>");
  });

  it.each(["codeqwen:7b-code-v1.5", "qwen-7b"])(
    "keeps StarCoder-style tokens for %s",
    (model) => {
      const rendered = render(model);
      expect(rendered).toContain("<fim_prefix>");
      expect(rendered).not.toContain("<|fim_prefix|>");
    },
  );
});
