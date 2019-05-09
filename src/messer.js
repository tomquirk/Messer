const repl = require("repl");
const { Messen } = require("messen");

const helpers = require("./util/helpers.js");
const { getCommandHandler } = require("./commands/command-handlers");
const eventHandlers = require("./event-handlers");
const logger = require("./util/logger");
const lock = require("./util/lock");

const APPSTATE_DIR = `${process.env.HOME}/.messer`;

const getMessen = ctx => {
  const messen = new Messen({
    dir: APPSTATE_DIR,
  });

  messen.getMfaCode = () => helpers.promptCode();
  messen.promptCredentials = () => helpers.promptCredentials();
  messen.onMessage = ev => {
    const handler = eventHandlers.message.bind(ctx);
    return handler(ev, lock);
  };
  messen.onThreadEvent = ev => {
    const handler = eventHandlers.event.bind(ctx);
    return handler(ev);
  };

  return messen;
};

/**
 * Creates a singleton that represents a Messer session.
 * @class
 */
function Messer(options = {}) {
  this.messen = getMessen(this);
  this.repl = undefined;

  this.lastThread = null;
  this.unreadMessagesCount = 0;
  this.debug = options.debug || false;
}

Messer.prototype.log = function log(message, color) {
  if (!this.repl) return;

  this.repl.clearBufferedCommand();
  logger.log(message, color);
  this.repl.displayPrompt(true);
};

/**
 * Starts a Messer session.
 */
Messer.prototype.start = function start() {
  helpers.notifyTerminal();
  logger.log("Logging in...");
  return this.messen
    .login()
    .then(() => {
      logger.log(
        `Successfully logged in as ${this.messen.store.users.me.user.name}`,
      );

      this.messen.listen();

      this.repl = repl.start({
        ignoreUndefined: true,
        eval: (input, context, filename, cb) =>
          this.processCommand(input)
            .then(res => {
              this.log(res);
              return cb(null);
            })
            .catch(err => {
              this.log(err.message);
              return cb(null);
            }),
      });
    })
    .catch(err => log(err));
};
/**
 * Starts Messer and executes a single command
 */
Messer.prototype.startSingle = function startSingle(rawCommand) {
  this.messen
    .login()
    .then(() => this.processCommand(rawCommand))
    .then(output => process.stdout.write(output))
    .catch(err => {
      process.stderr.write(err);
    });
};
/**
 * Execute appropriate action for user input commands.
 * @param {String} rawCommand - command to process
 * @return {Promise}
 */
Messer.prototype.processCommand = function processCommand(rawCommand) {
  this.clear(); // If we are typing, new messages have been read

  let localCommand = rawCommand;

  // ignore if rawCommand is only spaces
  if (localCommand.trim().length === 0) return Promise.resolve();

  const args = localCommand.replace("\n", "").split(" ");

  let commandHandler = getCommandHandler(args[0]);

  if (lock.isLocked()) {
    if (localCommand.trim() === "unlock") {
      commandHandler = getCommandHandler("unlock");
    } else {
      commandHandler = getCommandHandler("message");
      localCommand = `m "${lock.getLockedTarget()}" ${args.join(" ")}`;
    }
  }

  if (!commandHandler) {
    return Promise.reject(Error("Invalid command - check your syntax"));
  }

  return commandHandler
    .call(this, localCommand)

    .then(res => {
      if (!lock.isLocked() && !lock.isAnonymous()) return res;

      // delete the last message
      commandHandler = getCommandHandler("delete");
      localCommand = `delete "${lock.getLockedTarget()}" 1`;
      return commandHandler.call(this, localCommand).then(() => {
        return res;
      });
    });
};

/**
 * Clears the messer notification in the terminal title.
 */
Messer.prototype.clear = function clear() {
  if (this.unreadMessagesCount === 0) return;

  this.unreadMessagesCount = 0;
  helpers.notifyTerminal();
};

/**
 * Terminates the Messer session and removes all relevent files.
 */
Messer.prototype.logout = function logout() {
  return this.messen.logout().then(() => {
    process.exit();
  });
};

module.exports = Messer;
