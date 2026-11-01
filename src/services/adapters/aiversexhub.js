/**
 * AIVerseX Hub — instance of the Scalar-family platform adapter.
 * Separate instance from UniqueAI on purpose (no shared cache).
 */
const { createAdapter } = require('./scalarFamily');

module.exports = createAdapter('aiversexhub');
