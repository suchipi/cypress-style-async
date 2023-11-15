import { test, expect } from "vitest";
import { CypressStyleAsync } from "./index";

// Common pattern: if we don't yet have a thing we depend on, but it can be
// inferred, silently set it up and then re-run this command
test("self-re-enqueueing command", async () => {
  type Context = {
    phase: number;
    result: string;
  };

  const myQueue = new CypressStyleAsync<
    {
      setupPhase1: () => Promise<number>;
      setupPhase2: () => Promise<number>;
      runsInPhase2: () => Promise<number>;
    },
    Context
  >();

  myQueue.registerCommand("setupPhase1", async (command, commandApi) => {
    commandApi.writeContext({ phase: 1 });

    return 42;
  });

  myQueue.registerCommand("setupPhase2", async (command, commandApi) => {
    if (commandApi.context.phase !== 1) {
      myQueue.api.setupPhase1();
      return myQueue.api.setupPhase2();
    }

    commandApi.writeContext({ phase: 2 });

    return 43;
  });

  myQueue.registerCommand("runsInPhase2", async (command, commandApi) => {
    if (commandApi.context.phase !== 2) {
      myQueue.api.setupPhase2();
      return myQueue.api.runsInPhase2();
    }

    commandApi.writeContext({ result: "yeah" });

    return 44;
  });

  const api = myQueue.api;

  await api.runsInPhase2();

  expect(myQueue._context).toMatchInlineSnapshot(`
    {
      "lastReturnValue": 44,
      "phase": 2,
      "result": "yeah",
    }
  `);
});
