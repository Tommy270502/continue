import { expect, test } from "vitest";
import { BuiltInToolNames } from "./builtIn";
import { getConfigDependentToolDefinitions } from "./index";

test("searchWeb tool is not offered (hosted proxy retired)", async () => {
  const tools = await getConfigDependentToolDefinitions({
    rules: [],
    enableExperimentalTools: false,
    isRemote: false,
    modelName: "",
    ide: {} as any,
  });

  const searchWebTool = tools.find(
    (tool) => tool.function.name === BuiltInToolNames.SearchWeb,
  );
  expect(searchWebTool).toBeUndefined();
});
