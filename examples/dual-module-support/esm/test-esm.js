import AdvZlib from '../../../dist/esm/index.js';

console.log('Testing ESM Import');
console.log('AdvZlib class is available:', typeof AdvZlib === 'function');

const advZlib = new AdvZlib();

if (advZlib) {
  console.log('Success');
} else {
  console.log('Failed');
}