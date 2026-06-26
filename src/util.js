function fail(message, exitCode = 3) {
  const err = new Error(message);
  err.exitCode = exitCode;
  return err;
}

module.exports = { fail };
