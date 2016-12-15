/* eslint max-len: 0 */

import cloneDeep from "lodash/cloneDeep";
import assign from "lodash/assign";
import has from "lodash/has";
import traverse from "babel-traverse";
import * as babylon from "babylon";
import * as t from "babel-types";

let FROM_TEMPLATE = "_fromTemplate"; //Symbol(); // todo: probably wont get copied over
let TEMPLATE_SKIP = Symbol();

export default function (firstArg, ...rest) {
  if (typeof firstArg === "string") {
    return factory(firstArg, ...rest);
  } else {
    return template(firstArg, ...rest);
  }
}

function template (partials: Object | string[], ...args: Array<Object>) {
  if (!Array.isArray(partials)) {
    // support template({ options })`string`
    return templateApply.bind(undefined, partials);
  }
  return templateApply(null, partials, ...args);
}

function templateApply(opts: Object | null, partials: string[], ...args: Array<Object>) {
  if (partials.some((str) => str.includes("$BABEL_TEMPLATE$"))) {
    throw new Error("Template contains illegal substring $BABEL_TEMPLATE$");
  }

  if (partials.length == 1) {
    return factory(partials[0], opts);
  }

  const replacementSet = new Set();
  const replacementMap = new Map();
  const replacementValueMap = new Map();
  let hasNonNumericReplacement = false;
  for (const arg of args) {
    if (replacementMap.has(arg)) {
      continue;
    }

    if (typeof arg === "number") {
      replacementMap.set(arg, `$${arg}`);
    } else if (typeof arg === "string") {
      // avoid duplicates should t.toIdentifier produce the same result for different arguments
      const replacementBase = `$BABEL_TEMPLATE$$${t.toIdentifier(arg)}`;
      let replacement = replacementBase;
      for (let i = 2; replacementSet.has(replacement); i++) {
        replacement = `${replacementBase}${i}`;
      }
      replacementSet.add(replacement);
      replacementMap.set(arg, replacement);
      hasNonNumericReplacement = true;
    } else {
      // there can't be duplicates as the size always grows
      const name = `$BABEL_TEMPLATE$VALUE$${replacementValueMap.size}`;

      // TODO: check if the arg is a Node
      replacementMap.set(arg, name);
      replacementValueMap.set(name, arg);
      hasNonNumericReplacement = true;
    }
  }

  if (hasNonNumericReplacement && replacementMap.has(0)) {
    throw new Error("Template cannot have a '0' replacement and a named replacement at the same time");
  }

  const code = partials.reduce((acc, partial, i) => {
    if (acc == null) {
      return partial;
    }

    const replacement = replacementMap.get(args[i - 1]);
    return `${acc}${replacement}${partial}`;
  }, null);

  const func = factory(code, opts);

  return (...args: Array<Object>) => {
    if (hasNonNumericReplacement) {
      const argObj = args[0] || {};
      const converted = {};

      for (const [key, replacement] of replacementMap) {
        if (typeof key === "number") continue;
        if (replacementValueMap.has(replacement)) {
          converted[replacement] = replacementValueMap.get(replacement);
        } else {
          converted[replacement] = argObj[key];
        }
      }

      args[0] = converted;
    }

    return func(...args);
  };
}

function factory (code: string, opts?: Object): Function {
  // since we lazy parse the template, we get the current stack so we have the
  // original stack to append if it errors when parsing
  let stack;
  try {
    // error stack gets populated in IE only on throw (https://msdn.microsoft.com/en-us/library/hh699850(v=vs.94).aspx)
    throw new Error();
  } catch (error) {
    if (error.stack) {
      // error.stack does not exists in IE <= 9
      stack = error.stack.split("\n").slice(1).join("\n");
    }
  }

  opts = assign({
    allowReturnOutsideFunction: true,
    allowSuperOutsideMethod: true,
    preserveComments: false,
  }, opts);

  let getAst = function () {
    let ast;

    try {
      ast = babylon.parse(code, opts);

      ast = traverse.removeProperties(ast, {preserveComments: opts.preserveComments});

      traverse.cheap(ast, function (node) {
        node[FROM_TEMPLATE] = true;
      });
    } catch (err) {
      err.stack = `${err.stack}from\n${stack}`;
      throw err;
    }

    getAst = function () {
      return ast;
    };

    return ast;
  };

  return function (...args) {
    return useTemplate(getAst(), args);
  };
}

function useTemplate(ast, nodes?: Array<Object>) {
  ast = cloneDeep(ast);
  let { program } = ast;

  if (nodes.length) {
    traverse(ast, templateVisitor, null, nodes);
  }

  if (program.body.length > 1) {
    return program.body;
  } else {
    return program.body[0];
  }
}

let templateVisitor = {
  // 360
  noScope: true,

  enter(path, args) {
    let { node } = path;
    if (node[TEMPLATE_SKIP]) return path.skip();

    if (t.isExpressionStatement(node)) {
      node = node.expression;
    }

    let replacement;

    if (t.isIdentifier(node) && node[FROM_TEMPLATE]) {
      if (has(args[0], node.name)) {
        replacement = args[0][node.name];
      } else if (node.name[0] === "$") {
        let i = +node.name.slice(1);
        if (args[i]) replacement = args[i];
      }
    }

    if (replacement === null) {
      path.remove();
    }

    if (replacement) {
      replacement[TEMPLATE_SKIP] = true;
      path.replaceInline(replacement);
    }
  },

  exit({ node }) {
    if (!node.loc)
      traverse.clearNode(node);
  }
};
