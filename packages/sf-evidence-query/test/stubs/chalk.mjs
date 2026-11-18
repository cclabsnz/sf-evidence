const handler = {
  get(target, prop) {
    if (prop === 'level') return 0;
    return target;
  },
  apply(target, _this, args) {
    return String(args[0] ?? '');
  },
};
const chalk = new Proxy(function () {}, handler);
export default chalk;
export const Chalk = function () { return chalk; };
export const chalkStderr = chalk;
export const supportsColor = false;
export const supportsColorStderr = false;
export const modifierNames = [];
export const foregroundColorNames = [];
export const backgroundColorNames = [];
export const colorNames = [];
