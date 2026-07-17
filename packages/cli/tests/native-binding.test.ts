// @vitest-environment node

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface BindingTarget {
  target_name: string;
  sources: string[];
  msvs_settings?: {
    VCCLCompilerTool?: Record<string, unknown>;
  };
}

const bindingPath = join(__dirname, "../native/process-tree/binding.gyp");
const binding = JSON.parse(readFileSync(bindingPath, "utf8")) as { targets: BindingTarget[] };
const target = binding.targets.find((candidate) => candidate.target_name === "process_tree");

describe("process-tree native binding", () => {
  it("compiles process_tree.c as C17 without inheriting Node's C++20 option", () => {
    expect(target).toBeDefined();
    expect(target?.sources).toEqual(["process_tree.c"]);
    expect(target?.msvs_settings?.VCCLCompilerTool).toMatchObject({
      CompileAs: "1",
      LanguageStandard_C: "stdc17",
      "AdditionalOptions!": ["-std:c++20"],
    });
  });
});
