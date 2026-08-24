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
  _runningCommand: CommandInvocation | null = null;
  isRunning: boolean = false;
  _queueStartScheduled: boolean = false;

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
    // Live read, so awaiting the bare api inside a handler doesn't deadlock.
    this._defineThenable(this.api, () => this._runningCommand);
  }

  _defineThenable(target: any, getOwner: () => CommandInvocation | null): void {
    Object.defineProperties(target, {
      then: {
        configurable: true,
        enumerable: false,
        get: () => {
          const promise = this._promiseForAwaiting(getOwner());
          return promise.then.bind(promise);
        },
      },
      catch: {
        configurable: true,
        enumerable: false,
        get: () => {
          const promise = this._promiseForAwaiting(getOwner());
          return promise.catch.bind(promise);
        },
      },
      finally: {
        configurable: true,
        enumerable: false,
        get: () => {
          const promise = this._promiseForAwaiting(getOwner());
          return promise.finally.bind(promise);
        },
      },
    });
  }

  // Fresh object per call: a shared one can't tell an await inside the owning
  // handler apart from an await on a chain queued earlier.
  _makeChainable(owner: CommandInvocation | null): any {
    // Inherited, so chainables pick up commands registered after they're made.
    const chainable = Object.create(this.api);
    this._defineThenable(chainable, () => owner);
    return chainable;
  }

  _promiseForAwaiting(owner: CommandInvocation | null): Promise<any> {
    // Waiting on the run would deadlock: it's parked on `owner`, the awaiter.
    if (owner != null && this._runningCommand === owner) {
      return this._runQueuedSubCommands();
    }
    return this._currentPromise;
  }

  _runQueuedSubCommands(): Promise<any> {
    const subCommands = this._nextPrependedCommandQueue;
    this._nextPrependedCommandQueue = [];
    return this._runCommands(subCommands).then(
      () => this._context.lastReturnValue
    );
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
    if (this._runningCommand != null) {
      this._nextPrependedCommandQueue.push(command);
      this._debugLog(
        `Command enqueued as a sub-command of '${this._runningCommand.name}'`,
        command
      );
    } else {
      this._commandQueue.push(command);
      this._debugLog("Command enqueued at end", command);
    }
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
      const owner = this._runningCommand;
      const command = this._makeCommand(name, args);
      this._insert(command);
      this._scheduleQueue();
      return this._makeChainable(owner);
    };

    this.api[name] = apiMethod as any;
  }

  // Starts on a microtask so a whole tick's calls queue before the first one
  // runs; synchronously, they'd all look like sub-commands of it.
  _scheduleQueue(): void {
    if (this.isRunning || this._queueStartScheduled) {
      return;
    }
    this._queueStartScheduled = true;
    this._currentPromise = Promise.resolve()
      .then(() => {
        this._queueStartScheduled = false;
        return this._processQueue();
      })
      .then(() => this._context.lastReturnValue);
  }

  async _processQueue() {
    this._debugLog("Now running");
    this.isRunning = true;
    try {
      await this._runCommands(this._commandQueue);
    } catch (err: any) {
      this._debugLog("Stopped running due to error state", err);
      this.isRunning = false;
      this._nextPrependedCommandQueue = [];
      this._commandQueue = [];

      this._onError(err);
      // re-throw so this._currentPromise gets rejected
      throw err;
    }
    this.isRunning = false;
    this._debugLog("Finished running");
  }

  async _runCommands(queue: Array<CommandInvocation>): Promise<void> {
    while (queue.length > 0) {
      this._debugLog("Command queue:", queue);

      const command = queue.shift();
      if (command == null) {
        continue;
      }

      // Saved and restored because a handler awaiting the api re-enters here.
      const parentCommand = this._runningCommand;
      const parentSubCommands = this._nextPrependedCommandQueue;
      this._runningCommand = command;
      this._nextPrependedCommandQueue = [];

      let result;
      try {
        this._debugLog("Running command", command);
        const handler = this._commandHandlers[command.name];
        if (!handler) {
          throw new Error(
            `No registered command handler for command '${command.name}'`
          );
        }
        this._onCommandRun(command);
        result = await handler.doRun(
          command,
          this._makeCommandHelpers(command)
        );
      } finally {
        queue.unshift(...this._nextPrependedCommandQueue);
        this._nextPrependedCommandQueue = parentSubCommands;
        this._runningCommand = parentCommand;
      }

      this._context.lastReturnValue = result;
    }
  }
}
