import { test, expect } from "vitest";
import { type CommandInvocation, CypressStyleAsync } from "./index";

test("sample code", async () => {
  type Context = {
    intensity?: number;
    flicker?: boolean;
    inflensity?: string;
    ticker?: "yeah";
  };

  const calls: Array<[CommandInvocation, Context]> = [];

  const myQueue = new CypressStyleAsync<
    {
      intensity: (value: number) => Promise<void>;
      red: () => Promise<"red">;
      green: (flicker: boolean) => Promise<"green">;
      blue: (intensity: number) => Promise<"blue">;
      yellow: (inflensity: string, ticker: "yeah") => Promise<"yellow">;
    },
    Context
  >();

  myQueue.registerCommand("intensity", async (command, commandApi) => {
    calls.push([command, { ...commandApi.context }]);
    const [value] = command.args;
    commandApi.writeContext({ intensity: value });
  });
  myQueue.registerCommand("red", async (command, commandApi) => {
    calls.push([command, { ...commandApi.context }]);
    await commandApi.sleep(3);
    return "red";
  });
  myQueue.registerCommand("green", async (command, commandApi) => {
    calls.push([command, { ...commandApi.context }]);
    const [flicker] = command.args;
    commandApi.writeContext({ flicker });
    return "green";
  });
  myQueue.registerCommand("blue", async (command, commandApi) => {
    calls.push([command, { ...commandApi.context }]);
    await commandApi.sleep(6);
    const [intensity] = command.args;
    commandApi.writeContext({ intensity });
    return "blue";
  });
  myQueue.registerCommand("yellow", async (command, commandApi) => {
    calls.push([command, { ...commandApi.context }]);
    const [inflensity, ticker] = command.args;
    commandApi.writeContext({ inflensity, ticker });
    return "yellow";
  });

  const api = myQueue.api;

  const returnValue = await api.blue(55).green(true).intensity(99).red();
  expect(returnValue).toBe("red");

  api.green(false);
  const returnValue2 = await api.yellow("mhm", "yeah");
  expect(returnValue2).toBe("yellow");

  expect(calls).toMatchInlineSnapshot(`
    [
      [
        {
          "args": [
            55,
          ],
          "name": "blue",
          "retryCount": 0,
        },
        {
          "lastReturnValue": undefined,
        },
      ],
      [
        {
          "args": [
            true,
          ],
          "name": "green",
          "retryCount": 0,
        },
        {
          "intensity": 55,
          "lastReturnValue": "blue",
        },
      ],
      [
        {
          "args": [
            99,
          ],
          "name": "intensity",
          "retryCount": 0,
        },
        {
          "flicker": true,
          "intensity": 55,
          "lastReturnValue": "green",
        },
      ],
      [
        {
          "args": [],
          "name": "red",
          "retryCount": 0,
        },
        {
          "flicker": true,
          "intensity": 99,
          "lastReturnValue": undefined,
        },
      ],
      [
        {
          "args": [
            false,
          ],
          "name": "green",
          "retryCount": 0,
        },
        {
          "flicker": true,
          "intensity": 99,
          "lastReturnValue": "red",
        },
      ],
      [
        {
          "args": [
            "mhm",
            "yeah",
          ],
          "name": "yellow",
          "retryCount": 0,
        },
        {
          "flicker": false,
          "intensity": 99,
          "lastReturnValue": "green",
        },
      ],
    ]
  `);

  expect(myQueue._context).toMatchInlineSnapshot(`
    {
      "flicker": false,
      "inflensity": "mhm",
      "intensity": 99,
      "lastReturnValue": "yellow",
      "ticker": "yeah",
    }
  `);
});
