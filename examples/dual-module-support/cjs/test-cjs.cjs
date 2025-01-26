const AdvZlib = require('../../../dist/cjs/index.cjs');

console.log('Testing CJS Require');
console.log('AdvZlib class is available:', typeof AdvZlib === 'function');

const advZlib = new AdvZlib();

if (advZlib) {
  console.log('Success');
} else {
  console.log('Failed');
}
