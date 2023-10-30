import makeDebug from "debug";
const debug = makeDebug("cypress-style-async");

export interface CommandInvocation<Args = any> {
  name: string;
  args: Args;
  retryCount: number;
}

export type ContextSupertype = { lastReturnValue: any };

export interface CommandApi<Context extends ContextSupertype> {
  readonly context: Context;

  writeContext(obj: Partial<Context>): void;
  clearContext(): void;

  sleep(ms: number): Promise<void>;
  retry(arg: { error: Error; maxRetries: number }): void;
}

export interface ApiSupertype {
  [commandName: string]: (...args: any) => any;
}

class CypressStyleAsync<
  Api extends ApiSupertype,
  Context extends ContextSupertype = ContextSupertype,
> {
  _context: Context;

  api: Partial<{
    [Key in keyof Api]: (...params: Parameters<Api[Key]>) => typeof this.api;
  }>;

  _commandHandlers: Partial<{
    [Name in keyof Api]: {
      doRun: (
        command: CommandInvocation<Parameters<Api[Name]>>,
        commandApi: CommandApi<Context>
      ) => Promise<void>;
    };
  }>;

  _commandQueue: Array<CommandInvocation>;
  _nextPrependedCommandQueue: Array<CommandInvocation>;
  isRunning: boolean;
  _insertionMode: "start" | "end";
  _onError: (err: Error) => void;
  _onCommandRun: (command: CommandInvocation) => void;

  constructor({
    onError = () => {},
    onCommandRun = () => {},
  }: {
    onError?: (err: Error) => void;
    onCommandRun?: (command: CommandInvocation) => void;
  } = {}) {
    // @ts-ignore could be instantiated with different constraint
    this._context = {};
    this.api = {} as any;
    this._commandHandlers = {} as any;
    this._commandQueue = [];
    this._nextPrependedCommandQueue = [];
    this.isRunning = false;
    this._insertionMode = "end";
    this._onError = onError;
    this._onCommandRun = onCommandRun;
  }

  _makeCommand<Name extends keyof Api & string>(
    name: Name,
    args: Parameters<Api[Name]>
  ): CommandInvocation<Parameters<Api[Name]>> {
    return { name, args, retryCount: 0 };
  }

  _makeCommandApi(command: CommandInvocation): CommandApi<Context> {
    const self = this;
    return {
      get context() {
        return self._context;
      },
      writeContext: (obj) => {
        Object.assign(this._context, obj);
      },
      clearContext: () => {
        // @ts-ignore could be assignable to different constraint
        this._context = {};
      },
      sleep(ms) {
        return new Promise((resolve) => setTimeout(resolve, ms));
      },
      retry: ({ error, maxRetries }) => {
        if (command.retryCount >= maxRetries) {
          throw error;
        } else {
          command.retryCount += 1;
          this._nextPrependedCommandQueue.unshift(command);
        }
      },
    };
  }

  _insert(command: CommandInvocation): void {
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

  registerCommand<Name extends keyof Api & string>(
    name: Name,
    doRun: (
      command: CommandInvocation<Parameters<Api[Name]>>,
      commandApi: CommandApi<Context>
    ) => Promise<void>
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
      if (command == null) {
        continue;
      }

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
      } catch (err: any) {
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
}

module.exports = CypressStyleAsync;
