/**
 * Unique AI Zone — instance of the Scalar-family platform adapter.
 * Separate instance from AIVerseX on purpose (no shared cache).
 */
const { createAdapter } = require('./scalarFamily');

module.exports = createAdapter('uniqueaizone');
