import { test, expect } from "vitest";
import { sleep } from "a-mimir";
import { CypressStyleAsync } from "./index";

test("an awaited sub-command resolves to its real return value", async () => {
  const myQueue = new CypressStyleAsync<
    {
      inner: () => Promise<string>;
      outer: () => Promise<string>;
    },
    {}
  >();

  let seenByOuter: any = "NOT SET";

  myQueue.registerCommand("inner", async () => "inner-value");
  myQueue.registerCommand("outer", async () => {
    seenByOuter = await myQueue.api.inner();
    return `outer saw ${seenByOuter}`;
  });

  expect(await myQueue.api.outer()).toBe("outer saw inner-value");
  expect(seenByOuter).toBe("inner-value");
});

test("a returned chainable resolves to the re-run's return value", async () => {
  type Context = { phase: number };

  const myQueue = new CypressStyleAsync<
    {
      setup: () => Promise<number>;
      run: () => Promise<number>;
    },
    Context
  >();

  myQueue.registerCommand("setup", async (command, commandApi) => {
    commandApi.writeContext({ phase: 1 });
    return 1;
  });
  myQueue.registerCommand("run", async (command, commandApi) => {
    if (commandApi.context.phase !== 1) {
      myQueue.api.setup();
      return myQueue.api.run();
    }
    return 99;
  });

  expect(await myQueue.api.run()).toBe(99);
});

test("re-enqueueing works after the handler has already awaited", async () => {
  type Context = { phase: number; result: string };

  const myQueue = new CypressStyleAsync<
    {
      setup: () => Promise<number>;
      run: () => Promise<number>;
    },
    Context
  >();

  myQueue.registerCommand("setup", async (command, commandApi) => {
    await sleep.async(5);
    commandApi.writeContext({ phase: 1 });
    return 1;
  });
  myQueue.registerCommand("run", async (command, commandApi) => {
    await sleep.async(5);
    if (commandApi.context.phase !== 1) {
      myQueue.api.setup();
      return myQueue.api.run();
    }
    commandApi.writeContext({ result: "ok" });
    return 2;
  });

  expect(await myQueue.api.run()).toBe(2);
  expect(myQueue._context).toEqual({
    lastReturnValue: 2,
    phase: 1,
    result: "ok",
  });
});

test("a handler can await several sub-commands in sequence", async () => {
  const order: Array<string> = [];

  const myQueue = new CypressStyleAsync<
    {
      a: () => Promise<string>;
      b: () => Promise<string>;
      top: () => Promise<string>;
    },
    {}
  >();

  myQueue.registerCommand("a", async () => {
    order.push("a");
    return "A";
  });
  myQueue.registerCommand("b", async () => {
    order.push("b");
    return "B";
  });
  myQueue.registerCommand("top", async () => {
    order.push("top-start");
    const one = await myQueue.api.a();
    const two = await myQueue.api.b();
    order.push("top-end");
    return one + two;
  });

  expect(await myQueue.api.top()).toBe("AB");
  expect(order).toEqual(["top-start", "a", "b", "top-end"]);
});

test("a chained sub-command resolves to the last link", async () => {
  const order: Array<string> = [];

  const myQueue = new CypressStyleAsync<
    {
      x: () => Promise<string>;
      y: () => Promise<string>;
      outer: () => Promise<string>;
    },
    {}
  >();

  myQueue.registerCommand("x", async () => {
    order.push("x");
    return "X";
  });
  myQueue.registerCommand("y", async () => {
    order.push("y");
    return "Y";
  });
  myQueue.registerCommand("outer", async () => {
    return await myQueue.api.x().y();
  });

  expect(await myQueue.api.outer()).toBe("Y");
  expect(order).toEqual(["x", "y"]);
});

test("sub-commands nest arbitrarily deep", async () => {
  const myQueue = new CypressStyleAsync<
    {
      l1: () => Promise<string>;
      l2: () => Promise<string>;
      l3: () => Promise<string>;
    },
    {}
  >();

  myQueue.registerCommand("l3", async () => "3");
  myQueue.registerCommand("l2", async () => "2" + (await myQueue.api.l3()));
  myQueue.registerCommand("l1", async () => "1" + (await myQueue.api.l2()));

  expect(await myQueue.api.l1()).toBe("123");
});

test("a sub-command that isn't awaited still runs after its enqueuer", async () => {
  const order: Array<string> = [];

  const myQueue = new CypressStyleAsync<
    {
      first: () => Promise<void>;
      later: () => Promise<void>;
      last: () => Promise<void>;
    },
    {}
  >();

  myQueue.registerCommand("first", async () => {
    order.push("first-start");
    myQueue.api.later(); // deliberately not awaited
    order.push("first-end");
  });
  myQueue.registerCommand("later", async () => {
    order.push("later");
  });
  myQueue.registerCommand("last", async () => {
    order.push("last");
  });

  await myQueue.api.first().last();
  expect(order).toEqual(["first-start", "first-end", "later", "last"]);
});

test("an error in a sub-command reaches onError exactly once", async () => {
  const errors: Array<string> = [];

  const myQueue = new CypressStyleAsync<
    {
      boom: () => Promise<void>;
      outer: () => Promise<void>;
    },
    {}
  >({ onError: (err) => errors.push(err.message) });

  myQueue.registerCommand("boom", async () => {
    throw new Error("kaboom");
  });
  myQueue.registerCommand("outer", async () => {
    await myQueue.api.boom();
  });

  await expect(myQueue.api.outer()).rejects.toThrow("kaboom");
  expect(errors).toEqual(["kaboom"]);
});

test("a handler can catch a failing sub-command", async () => {
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
    try {
      await myQueue.api.boom();
      return "no error";
    } catch (err: any) {
      return `caught ${err.message}`;
    }
  });

  expect(await myQueue.api.outer()).toBe("caught kaboom");
});

test("retry works inside a sub-command", async () => {
  let attempts = 0;

  const myQueue = new CypressStyleAsync<
    {
      flaky: () => Promise<string>;
      outer: () => Promise<string>;
    },
    {}
  >();

  myQueue.registerCommand("flaky", async (command, commandApi) => {
    attempts += 1;
    if (attempts < 3) {
      commandApi.retry({ error: new Error("nope"), maxRetries: 5 });
      return undefined as any;
    }
    return "done";
  });
  myQueue.registerCommand("outer", async () => {
    return `got ${await myQueue.api.flaky()}`;
  });

  expect(await myQueue.api.outer()).toBe("got done");
  expect(attempts).toBe(3);
});

test("nesting leaves no state behind", async () => {
  const myQueue = new CypressStyleAsync<
    {
      inner: () => Promise<number>;
      outer: () => Promise<number>;
    },
    {}
  >();

  myQueue.registerCommand("inner", async () => 7);
  myQueue.registerCommand("outer", async () => (await myQueue.api.inner()) + 1);

  expect(await myQueue.api.outer()).toBe(8);

  expect(myQueue._runningCommand).toBe(null);
  expect(myQueue.isRunning).toBe(false);
  expect(myQueue._commandQueue).toEqual([]);
  expect(myQueue._nextPrependedCommandQueue).toEqual([]);

  expect(await myQueue.api.outer()).toBe(8);
});
