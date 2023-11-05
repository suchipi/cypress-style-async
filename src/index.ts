export interface CommandInvocation<Args = any> {
  name: string;
  args: Args;
  retryCount: number;
}

export interface ChainHelpers<Context extends {}> {
  readonly context: Context & { lastReturnValue: any };

  writeContext(obj: Partial<Context>): void;
  clearContext(): void;

  retry(arg: { error: Error; maxRetries: number }): void;
}

// TODO: way to type the effect a command has on context,
// and specify that certain commands require certain context values.
export interface CommandsMapSupertype {
  [commandName: string]: (...args: any) => Promise<any>;
}

export type PromiseWithMethods<
  LastReturnValue,
  CommandsMap extends CommandsMapSupertype,
> = {
  [Key in keyof CommandsMap]: (
    ...params: Parameters<CommandsMap[Key]>
  ) => PromiseWithMethods<Awaited<ReturnType<CommandsMap[Key]>>, CommandsMap>;
} & Promise<LastReturnValue>;

export class CypressStyleAsync<
  CommandsMap extends CommandsMapSupertype,
  ChainContext extends {},
  LastReturnValue = undefined,
> {
  // @ts-ignore could be instantiated with different constraint
  _context: ChainContext & { lastReturnValue: LastReturnValue } = {
    lastReturnValue: undefined,
  };

  api: PromiseWithMethods<LastReturnValue, CommandsMap>;

  _currentPromise: Promise<LastReturnValue> = Promise.resolve() as any;

  _commandHandlers: Partial<{
    [Name in keyof CommandsMap]: {
      doRun: (
        command: CommandInvocation<Parameters<CommandsMap[Name]>>,
        helpers: ChainHelpers<ChainContext>
      ) => Promise<void>;
    };
  }> = {};

  _commandQueue: Array<CommandInvocation> = [];
  _nextPrependedCommandQueue: Array<CommandInvocation> = [];
  isRunning: boolean = false;
  _insertionMode: "start" | "end" = "end";

  _onError: (err: Error) => void;
  _onCommandRun: (command: CommandInvocation) => void;
  _debugLog: (...args: any) => void;

  constructor({
    onError = () => {},
    onCommandRun = () => {},
    debugLog = () => {},
  }: {
    onError?: (err: Error) => void;
    onCommandRun?: (command: CommandInvocation) => void;
    debugLog?: (...args: any) => void;
  } = {}) {
    this._onError = onError;
    this._onCommandRun = onCommandRun;
    this._debugLog = debugLog;

    this.api = {} as any;
    Object.defineProperties(this.api, {
      then: {
        configurable: true,
        enumerable: false,
        get: () => {
          const promise = this._currentPromise;
          return promise.then.bind(promise);
        },
      },
      catch: {
        configurable: true,
        enumerable: false,
        get: () => {
          const promise = this._currentPromise;
          return promise.catch.bind(promise);
        },
      },
      finally: {
        configurable: true,
        enumerable: false,
        get: () => {
          const promise = this._currentPromise;
          return promise.finally.bind(promise);
        },
      },
    });
  }

  _makeCommand<Name extends keyof CommandsMap & string>(
    name: Name,
    args: Parameters<CommandsMap[Name]>
  ): CommandInvocation<Parameters<CommandsMap[Name]>> {
    return { name, args, retryCount: 0 };
  }

  _makeCommandHelpers(command: CommandInvocation): ChainHelpers<ChainContext> {
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
    this._debugLog(`Command enqueued at ${this._insertionMode}`, command);
  }

  registerCommand<Name extends keyof CommandsMap & string>(
    name: Name,
    doRun: (
      command: CommandInvocation<Parameters<CommandsMap[Name]>>,
      helpers: ChainHelpers<ChainContext>
    ) => ReturnType<CommandsMap[Name]>
  ) {
    this._commandHandlers[name] = {
      doRun,
    };

    const apiMethod = (...args: any) => {
      const command = this._makeCommand(name, args);
      this._insert(command);
      if (!this.isRunning) {
        this._currentPromise = this._processQueue().then(
          () => this._context.lastReturnValue
        );
      }
      return this.api;
    };

    this.api[name] = apiMethod as any;
  }

  async _processQueue() {
    this._debugLog("Now running");
    this.isRunning = true;
    while (this._commandQueue.length > 0) {
      this._debugLog("Command queue:", this._commandQueue);

      const command = this._commandQueue.shift();
      if (command == null) {
        continue;
      }

      let result;
      try {
        this._debugLog("Running command", command);
        const handler = this._commandHandlers[command.name];
        if (!handler) {
          throw new Error(
            `No registered command handler for command '${command.name}'`
          );
        }
        this._insertionMode = "start";
        this._onCommandRun(command);
        result = await handler.doRun(
          command,
          this._makeCommandHelpers(command)
        );
      } catch (err: any) {
        this._debugLog("Stopped running due to error state", err);
        this._insertionMode = "end";
        this.isRunning = false;
        this._nextPrependedCommandQueue = [];
        this._commandQueue = [];

        this._onError(err);
        // re-throw so this._currentPromise gets rejected
        throw err;
      }
      this._context.lastReturnValue = result;

      this._commandQueue = this._nextPrependedCommandQueue.concat(
        this._commandQueue
      );
      this._nextPrependedCommandQueue = [];
    }
    this._insertionMode = "end";
    this.isRunning = false;
    this._debugLog("Finished running");
  }
}
