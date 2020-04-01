const Sentry = require('@sentry/node');

module.exports = () => {
  const { env } = process;
  const isDebug = env.NODE_ENV !== 'production';
  if (env.SENTRY_DSN) {
    Sentry.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      attachStacktrace: true,
    });
  }

  const consoleLog = console.log;
  console.log = (m) => consoleLog(`${(new Date()).toISOString()} ${m}`);

  if (isDebug) {
    if (typeof (console.info) !== 'function') {
      console.info = (i) => console.log(`[INFO]: ${i}`);
    } else {
      const consoleInfo = console.info;
      console.info = (i) => consoleInfo(`${(new Date()).toISOString()} [INFO]: ${i}`);
    }
  } else {
    console.info = () => {};
  }

  if (typeof (console.error) !== 'function') {
    console.error = (e) => {
      console.log(`[ERROR]: ${e}`);
      Sentry.captureException(e);
    };
  } else {
    const consoleError = console.error;
    console.error = (e) => {
      consoleError(`${(new Date()).toISOString()} [ERROR]: ${e}`);
      Sentry.captureException(e);
    };
  }

  if (typeof (console.warn) !== 'function') {
    console.warn = (w) => console.log(`[WARN]: ${w}`);
  } else {
    const consoleWarn = console.warn;
    console.warn = (w) => consoleWarn(`${(new Date()).toISOString()} [WARN]: ${w}`);
  }
};
