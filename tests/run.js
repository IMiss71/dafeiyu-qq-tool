// Run all tests in one process (Node's test runner spawns children by default,
// which fails under restricted Windows sandboxes). CI can still use `node --test`.
require('./static.test.js');
require('./core.test.js');
require('./plan.test.js');
require('./plugin.test.js');
