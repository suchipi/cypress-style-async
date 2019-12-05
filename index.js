const debug = require("debug")("cypress-style-async");

module.exports = class CypressStyleAsync {
  constructor({ onError = (err) => {}, onCommandRun = (command) => {} } = {}) {
    this._context = {};
    this.api = {};
    this._commandHandlers = {};
    this._commandQueue = [];
    this._nextPrependedCommandQueue = [];
    this.isRunning = false;
    this._insertionMode = "end";
    this._onError = onError;
    this._onCommandRun = onCommandRun;
  }

  _makeCommand(name, args) {
    return { name, args, retryCount: 0 };
  }

  _makeCommandApi(command) {
    const self = this;
    return {
      get context() {
        return self.context;
      },
      writeContext(obj) {
        Object.assign(self.context, obj);
      },
      clearContext() {
        self.context = {};
      },
      sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
      retry({ error, maxRetries }) {
        if (command.retryCount >= maxRetries) {
          throw error;
        } else {
          command.retryCount += 1;
          self._nextPrependedCommandQueue.unshift(command);
        }
      },
    };
  }

  _insert(command) {
    switch (this._insertionMode) {
      case "end": {
        this._commandQueue.push(command);
        break;
      }
      case "start": {
        this._nextPrependedCommandQueue.push(command);
      }
    }
    debug(`Command enqueued at ${this._insertionMode}`, command);
  }

  registerCommand(
    name,
    doRun = async (command, commandApi) => {
      // Override pls
    }
  ) {
    this._commandHandlers[name] = {
      doRun,
    };

    this.api[name] = (...args) => {
      const command = this._makeCommand(name, args);
      this._insert(command);
      if (!this.isRunning) {
        this._processQueue();
      }
      return this.api;
    };
  }

  async _processQueue() {
    debug("Now running");
    this.isRunning = true;
    while (this._commandQueue.length > 0) {
      debug("Command queue:", this._commandQueue);

      const command = this._commandQueue.shift();

      let result;
      try {
        debug("Running command", command);
        const handler = this._commandHandlers[command.name];
        if (!handler) {
          throw new Error(
            `No registered command handler for command '${command.name}'`
          );
        }
        this._insertionMode = "start";
        this._onCommandRun(command);
        result = await handler.doRun(command, this._makeCommandApi(command));
      } catch (err) {
        debug("Stopped running due to error state", err);
        this._insertionMode = "end";
        this.isRunning = false;
        this._nextPrependedCommandQueue = [];
        this._commandQueue = [];

        this._onError(err);
        return;
      }
      this._context.lastReturnValue = result;

      this._commandQueue = this._nextPrependedCommandQueue.concat(
        this._commandQueue
      );
      this._nextPrependedCommandQueue = [];
    }
    this._insertionMode = "end";
    this.isRunning = false;
    debug("Finished running");
  }
};
