# Cypress-Style Async

This library helps you create a chainable, queue-backed async API similar to the `cy` global used in [Cypress](cypress.io).

The way it works, is you register a bunch of commands that can be performed, and then the consumer of your API uses synchronous methods to queue those commands up, and then they are run asynchronously and serially in the background.

Please read [This page from Cypress's docs](https://docs.cypress.io/guides/core-concepts/introduction-to-cypress.html) to get a better idea of how this sync-feeling-but-actually-async queue-backed API pattern works.

## Usage

```js
const CypressStyleAsync = require("cypress-style-async");

const mySystem = new CypressStyleAsync({
  onError(error) {
    console.error(error);
  }
});

// mySystem.api is an object that behaves like the `cy` object in Cypress.

// registerCommand adds a method to mySystem.api.
mySystem.registerCommand("example", async (command, api) => {
  // command is an object with the shape { name, args }.
  command.name; // "example"
  command.args; // An array of arguments that `mySystem.api.example` was called with

  // api is an object.
  api.context; // An object that persists throughout the lifetime of mySystem. You can add properties to it with api.writeContext, and then read them again later in any command.

  api.writeContext({ something: 4 }); // Adds the property `something` with value `4` to the api.context object.

  api.clearContext(); // clears all the properties in the context object.

  await api.sleep(100); // uses setTimeout to wait 100ms.

  api.retry({ error: new Error("everything is bad"), maxRetries: 10 });
  // api.retry tells the system that an error occurred, and to re-run this command, unless
  // we have already retried this command the number of times specified in `maxRetries`, in which
  // case the error will bubble out to the `onError` function that was passed in when `mySystem` was
  // constructed, and `mySystem` won't execute any other commands in its queue.
});

// Now you can call `example`:
mySystem.api.example("bla", "bla");

// Here's a more concrete/realistic example of a command.
mySystem.registerCommand("fetchBlob", async (command, api) => {
  const url = command.args[0]; // User must pass url as first argument
  const options = command.args[1];

  let response;
  try {
    response = await window.fetch(url, options);
  } catch (error) {
    // If the fetch failed, we retry this command up to 10 times
    api.retry({ error, maxRetries: 10 });
    return;
  }

  const blob = await response.blob();

  api.writeContext({ fetchedBlob: blob });
};

// Once you have all your commands registered, you expose only `mySystem.api` to your users.
module.exports = mySystem.api;
```

## Sub-commands

A command handler can use `mySystem.api` itself. Commands it queues that way are **sub-commands** of the command that queued them.

If you `await` a sub-command (or `return` it), it runs right then, nested inside the handler, and you get its return value back:

```js
mySystem.registerCommand("outer", async (command, api) => {
  const value = await mySystem.api.inner(); // `inner` runs here, before `outer` finishes
  return `outer saw ${value}`;
});
```

If you don't await it, it runs after the current command finishes, ahead of whatever else was already queued:

```js
mySystem.registerCommand("outer", async (command, api) => {
  mySystem.api.inner(); // queued, runs once `outer` returns
  return "done";
});
```

You can queue a fresh copy of the current command as a sub-command, which is how you set up something you depend on and then start over:

```js
mySystem.registerCommand("runsInPhase2", async (command, api) => {
  if (api.context.phase !== 2) {
    mySystem.api.setupPhase2();
    // queues a second runsInPhase2, whose result becomes this one's result
    return mySystem.api.runsInPhase2();
  }

  return doTheActualWork();
});
```

Errors propagate normally: a failing sub-command rejects the `await` in its parent, so the parent can `try`/`catch` it. If nobody catches it, it bubbles out to `onError` once, no matter how deeply the failing command was nested.

### Caveat: don't queue commands from an unrelated async continuation

A command is treated as a sub-command whenever it's queued while another command is running. That's what makes the above work, but it means this doesn't do what it looks like:

```js
mySystem.api.slowThing();
await somethingUnrelated(); // `slowThing` starts running during this
await mySystem.api.other(); // treated as a sub-command of `slowThing`
```

`other` still runs, and the `await` still gives you its return value, but it runs nested inside `slowThing` rather than after it. Queue your commands synchronously (`api.a().b().c()`, or several statements in a row) and this won't come up. Cypress has the same caveat about interleaving `async`/`await` with commands.

## License

MIT
