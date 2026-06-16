// 🧮 Calculator plugin — a safe math evaluator (NO eval/Function).
// Tokenizer → shunting-yard → RPN → evaluate. Supports basic arithmetic plus
// advanced functions/constants. Exposed as an agent command (calc) and an HTTP
// route the panel calls, so agents and the user share the same engine.
//
// Built on the BagIdea Office plugin template — see the factory shape below.
// This plugin is self-contained math, so it doesn't use `ctx`; the template
// (bagidea-office-template) documents the full ctx API and every pattern.

const FUNCS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan,
  asin: Math.asin, acos: Math.acos, atan: Math.atan,
  sinh: Math.sinh, cosh: Math.cosh, tanh: Math.tanh,
  sqrt: Math.sqrt, cbrt: Math.cbrt, exp: Math.exp,
  ln: Math.log, log: (x) => Math.log10(x), log2: Math.log2,
  abs: Math.abs, floor: Math.floor, ceil: Math.ceil, round: Math.round,
  sign: Math.sign, deg: (x) => x * 180 / Math.PI, rad: (x) => x * Math.PI / 180,
  fact: (n) => {
    if (n < 0 || n !== Math.floor(n)) return NaN;
    let r = 1; for (let i = 2; i <= n; i++) r *= i; return r;
  },
};
const CONSTS = { pi: Math.PI, e: Math.E, tau: Math.PI * 2, phi: (1 + Math.sqrt(5)) / 2 };
const OPS = {
  "+": { p: 2, a: "L", f: (a, b) => a + b },
  "-": { p: 2, a: "L", f: (a, b) => a - b },
  "*": { p: 3, a: "L", f: (a, b) => a * b },
  "/": { p: 3, a: "L", f: (a, b) => a / b },
  "%": { p: 3, a: "L", f: (a, b) => a % b },
  "u-": { p: 3.5, a: "R", unary: true, f: (a) => -a }, // unary minus: binds tighter than * , looser than ^
  "^": { p: 4, a: "R", f: (a, b) => Math.pow(a, b) },
};

function tokenize(s) {
  const out = [];
  const re = /\s*([0-9]*\.?[0-9]+(?:[eE][-+]?[0-9]+)?|[A-Za-z_][A-Za-z0-9_]*|[-+*/%^()!,])/g;
  let m, last = null, i = 0;
  while ((m = re.exec(s))) {
    if (m.index !== i) throw new Error("bad character near: " + s.slice(i));
    let t = m[1];
    // unary minus/plus (at expr start, after "(", after "," or after an operator)
    const unary = (last === null || last === "(" || last === "," || (last in OPS));
    if (t === "+" && unary) { i = re.lastIndex; continue; }   // unary plus = no-op
    if (t === "-" && unary) t = "u-";                          // unary minus operator
    out.push(t); last = t; i = re.lastIndex;
  }
  if (i !== s.length) throw new Error("unexpected end");
  return out;
}

function evaluate(expr) {
  const tokens = tokenize(String(expr).toLowerCase());
  const output = [], stack = [];
  const isNum = (t) => /^[0-9.]/.test(t) || /[eE]/.test(t) && /^[0-9.]/.test(t);
  for (let k = 0; k < tokens.length; k++) {
    const t = tokens[k];
    if (/^[0-9]*\.?[0-9]/.test(t)) output.push(parseFloat(t));
    else if (t in CONSTS) output.push(CONSTS[t]);
    else if (t in FUNCS) stack.push({ fn: t });
    else if (t === "!") output.push({ post: "fact" });
    else if (t === ",") { while (stack.length && stack[stack.length - 1] !== "(") output.push(stack.pop()); }
    else if (t in OPS) {
      while (stack.length) {
        const top = stack[stack.length - 1];
        if (top === "(" ) break;
        if (top.fn) { output.push(stack.pop()); continue; }
        if (top in OPS && (OPS[top].a === "L" ? OPS[top].p >= OPS[t].p : OPS[top].p > OPS[t].p)) output.push(stack.pop());
        else break;
      }
      stack.push(t);
    } else if (t === "(") stack.push("(");
    else if (t === ")") {
      while (stack.length && stack[stack.length - 1] !== "(") output.push(stack.pop());
      if (!stack.length) throw new Error("mismatched )");
      stack.pop();
      if (stack.length && stack[stack.length - 1].fn) output.push(stack.pop());
    } else throw new Error("unknown token: " + t);
  }
  while (stack.length) { const s = stack.pop(); if (s === "(") throw new Error("mismatched ("); output.push(s); }

  const st = [];
  for (const tok of output) {
    if (typeof tok === "number") st.push(tok);
    else if (tok && tok.post === "fact") st.push(FUNCS.fact(st.pop()));
    else if (tok && tok.fn) st.push(FUNCS[tok.fn](st.pop()));
    else if (tok in OPS) {
      if (OPS[tok].unary) st.push(OPS[tok].f(st.pop()));
      else { const b = st.pop(), a = st.pop(); st.push(OPS[tok].f(a, b)); }
    }
    else throw new Error("eval error");
  }
  if (st.length !== 1 || !isFinite(st[0])) throw new Error("invalid expression");
  return st[0];
}

module.exports = () => ({
  onCommand(cmd, args, reply) {
    if (cmd !== "calc") return reply({ ok: false, msg: "unknown command: " + cmd });
    try {
      const result = evaluate(args);
      return reply({ ok: true, expr: String(args), result, msg: `${args} = ${result}` });
    } catch (e) { return reply({ ok: false, msg: "Error: " + e.message }); }
  },
  routes: {
    // GET /plugin/calculator/eval?e=<expr>
    eval(req, res) {
      const e = new URL(req.url, "http://x").searchParams.get("e") || "";
      res.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      try { res.end(JSON.stringify({ ok: true, result: evaluate(e) })); }
      catch (err) { res.end(JSON.stringify({ ok: false, msg: err.message })); }
    },
  },
});
