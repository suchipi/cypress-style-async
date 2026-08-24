import { test, expect } from "vitest";
import { CypressStyleAsync } from "./index";

test("a thrown error rejects the chain and reaches onError once", async () => {
  const errors: Array<string> = [];

  const myQueue = new CypressStyleAsync<{ boom: () => Promise<void> }, {}>({
    onError: (err) => errors.push(err.message),
  });

  myQueue.registerCommand("boom", async () => {
    throw new Error("kaboom");
  });

  await expect(myQueue.api.boom()).rejects.toThrow("kaboom");
  expect(errors).toEqual(["kaboom"]);
});

test("commands queued behind a failing one are dropped", async () => {
  const ran: Array<string> = [];

  const myQueue = new CypressStyleAsync<
    {
      boom: () => Promise<void>;
      after: () => Promise<void>;
    },
    {}
  >({ onError: () => {} });

  myQueue.registerCommand("boom", async () => {
    throw new Error("kaboom");
  });
  myQueue.registerCommand("after", async () => {
    ran.push("after");
  });

  await expect(myQueue.api.boom().after()).rejects.toThrow("kaboom");
  expect(ran).toEqual([]);
});

test("the queue is usable again after an error", async () => {
  const myQueue = new CypressStyleAsync<
    {
      boom: () => Promise<void>;
      ok: () => Promise<string>;
    },
    {}
  >({ onError: () => {} });

  myQueue.registerCommand("boom", async () => {
    throw new Error("kaboom");
  });
  myQueue.registerCommand("ok", async () => "fine");

  await expect(myQueue.api.boom()).rejects.toThrow("kaboom");
  expect(await myQueue.api.ok()).toBe("fine");
});

test("retry re-runs the command until it succeeds", async () => {
  let attempts = 0;

  const myQueue = new CypressStyleAsync<{ flaky: () => Promise<string> }, {}>();

  myQueue.registerCommand("flaky", async (command, commandApi) => {
    attempts += 1;
    if (attempts < 3) {
      commandApi.retry({ error: new Error("nope"), maxRetries: 5 });
      return undefined as any;
    }
    return "done";
  });

  expect(await myQueue.api.flaky()).toBe("done");
  expect(attempts).toBe(3);
});

test("retry gives up once maxRetries is hit", async () => {
  const errors: Array<string> = [];

  const myQueue = new CypressStyleAsync<{ flaky: () => Promise<void> }, {}>({
    onError: (err) => errors.push(err.message),
  });

  myQueue.registerCommand("flaky", async (command, commandApi) => {
    commandApi.retry({ error: new Error("always"), maxRetries: 2 });
  });

  await expect(myQueue.api.flaky()).rejects.toThrow("always");
  expect(errors).toEqual(["always"]);
});

test("a command with no registered handler errors", async () => {
  const myQueue = new CypressStyleAsync<{ nope: () => Promise<void> }, {}>({
    onError: () => {},
  });

  myQueue.registerCommand("nope", async () => {});
  // the api method only exists once the command is registered, so removing the
  // handler afterwards is the only way to reach this case
  delete myQueue._commandHandlers.nope;

  await expect(myQueue.api.nope()).rejects.toThrow(
    "No registered command handler for command 'nope'"
  );
});
