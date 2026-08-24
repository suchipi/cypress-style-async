import { test, expect } from "vitest";
import { sleep } from "a-mimir";
import { CypressStyleAsync } from "./index";

test("a chain captured before the run still waits for the whole run", async () => {
  const order: Array<string> = [];

  const myQueue = new CypressStyleAsync<
    {
      slowThing: () => Promise<string>;
      other: () => Promise<string>;
    },
    {}
  >();

  myQueue.registerCommand("slowThing", async () => {
    order.push("slow-start");
    await sleep.async(20);
    order.push("slow-end");
    return "SLOW";
  });
  myQueue.registerCommand("other", async () => {
    order.push("other");
    return "OTHER";
  });

  const chain = myQueue.api.slowThing();
  await sleep.async(5); // let slowThing get mid-flight before the next call

  expect(await myQueue.api.other()).toBe("OTHER");
  expect(order).toEqual(["slow-start", "other"]);

  await chain;
  expect(order).toEqual(["slow-start", "other", "slow-end"]);
});

test("a chainable awaited after its command finished waits for the run", async () => {
  const order: Array<string> = [];
  let captured: any;

  const myQueue = new CypressStyleAsync<
    {
      leaf: () => Promise<string>;
      outer: () => Promise<string>;
      tail: () => Promise<string>;
    },
    {}
  >();

  myQueue.registerCommand("leaf", async () => {
    order.push("leaf");
    return "L";
  });
  myQueue.registerCommand("tail", async () => {
    order.push("tail");
    return "T";
  });
  myQueue.registerCommand("outer", async () => {
    order.push("outer");
    captured = myQueue.api.leaf(); // queued, deliberately not awaited
    return "O";
  });

  await myQueue.api.outer().tail();

  expect(await captured).toBe("T");
  expect(order).toEqual(["outer", "leaf", "tail"]);
});

test("awaiting the bare api inside a handler runs its sub-commands", async () => {
  const myQueue = new CypressStyleAsync<
    {
      inner: () => Promise<string>;
      outer: () => Promise<any>;
    },
    {}
  >();

  myQueue.registerCommand("inner", async () => "I");
  myQueue.registerCommand("outer", async () => {
    myQueue.api.inner();
    return await myQueue.api;
  });

  expect(await myQueue.api.outer()).toBe("I");
});

test("awaiting the bare api outside a handler waits for the run", async () => {
  const order: Array<string> = [];

  const myQueue = new CypressStyleAsync<{ slow: () => Promise<string> }, {}>();

  myQueue.registerCommand("slow", async () => {
    await sleep.async(10);
    order.push("slow");
    return "S";
  });

  myQueue.api.slow();
  expect(await myQueue.api).toBe("S");
  expect(order).toEqual(["slow"]);
});

test("each api call returns its own chainable", async () => {
  const myQueue = new CypressStyleAsync<{ a: () => Promise<string> }, {}>();
  myQueue.registerCommand("a", async () => "A");

  const one = myQueue.api.a();
  const two = myQueue.api.a();

  expect(one).not.toBe(two);
  expect(one).not.toBe(myQueue.api);
  await two;
});

test("a chainable picks up commands registered after it was made", async () => {
  const myQueue = new CypressStyleAsync<
    {
      a: () => Promise<string>;
      b: () => Promise<string>;
    },
    {}
  >();

  myQueue.registerCommand("a", async () => "A");
  const chain = myQueue.api.a();
  myQueue.registerCommand("b", async () => "B");

  expect(await chain.b()).toBe("B");
});

test("catch and finally work on a chainable inside a handler", async () => {
  const seen: Array<string> = [];

  const myQueue = new CypressStyleAsync<
    {
      boom: () => Promise<void>;
      outer: () => Promise<string>;
    },
    {}
  >();

  myQueue.registerCommand("boom", async () => {
    throw new Error("kaboom");
  });
  myQueue.registerCommand("outer", async () => {
    return await myQueue.api
      .boom()
      .catch((err: any) => `caught ${err.message}`)
      .finally(() => {
        seen.push("finally");
      });
  });

  expect(await myQueue.api.outer()).toBe("caught kaboom");
  expect(seen).toEqual(["finally"]);
});
