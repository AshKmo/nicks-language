#!/bin/env node

/*
 * Nick's Language sample parser
 * Written by AshKmo, 2024
 *
 * This script accepts a single file path to a text file containing the expression to be evaluated and evaluates it as per the Nick's Language specification.
 */

const fs = require('fs');

// debugging function
// accepts any number of arguments, logs all of them to the console on one line and returns the last one
function tee(...x) {
	console.log(...x);
	return x[x.length - 1];
}

function nixinter(exp) {
	function reverseByte(b) {
		b = (b & 0xF0) >> 4 | (b & 0x0F) << 4;
		b = (b & 0xCC) >> 2 | (b & 0x33) << 2;
		b = (b & 0xAA) >> 1 | (b & 0x55) << 1;
		return b;
	}

	const mkobj = (t, v) => ({ type: t, ...(v && {val: v}) });

	const Null = mkobj(9);

	function tokenise(exp, start = 0, end = exp.length) {
		const tokens = [];

		let token = "";

		let ltype = -1;
		let ctype = -1;

		let esc = false;
		let com = false;

		let i = start;
		for (; i <= end; i++) {
			const c = i === end ? '\n' : exp[i];

			if (!esc && c === '\\') {
				esc = true;
				continue;
			}

			if (!esc && c === '#') {
				com = !com;
				continue;
			}

			if (com) {
				esc = false;
				continue;
			}

			// rough type determination happens here
			// types are as follows:
			// 0: string (adjacent ordinary characters or specifically constructed strings)
			// 1: separation, spacing and alignment
			// 2: single-character tokens
			// 3: quotes and backticks
			// 4: set constructor
			// 5: function constructor
			// 10: number

			switch (c) {
				case ' ':
				case '\n':
				case '\t':
				case '\r': // for MS (Windows/DOS/etc.) compatibility
					ctype = 1;
					break;
				case '$':
				case '(':
				case ')':
				case '{':
				case '}':
				case '=':
				case ';':
				case ':':
					ctype = 2;
					break;
				case '"':
				case '\'':
				case '`':
					ctype = 3;
					break;
				default:
					ctype = 0;
					break;
			}

			if (!esc && ctype === 0 && (token.length === 0 || ltype === 10)) {
				switch (c) {
					case '0':
					case '1':
					case '2':
					case '3':
					case '4':
					case '5':
					case '6':
					case '7':
					case '8':
					case '9':
						ctype = 10;
						break;
				}
			}

			if (ltype === -1) {
				ltype = ctype;
			}

			if ((ltype !== -1 && (ctype === 2 || ctype !== ltype))) {
				if (token.length > 0) {
					tokens.push({
						type: ltype === 10 ? 0 : ltype,
						val: ltype === 0 ? Buffer.from(token, "utf8") : ltype === 10 ? intToData(Number(token)) : token,
						...(ltype === 0 && { len: token.length * 8 })
					});

					token = "";
				}

				ltype = ctype;
			}

			if (ctype === 3) {
				let res = "";

				let escaped = false;

				let x = i + 1;
				for (; x < exp.length; x++) {
					const c = exp[x];

					if (!esc && c === '\\') {
						esc = true;
						continue;
					}

					if (!esc && (c === '"' || c === '\'' || c === '`')) {
						break;
					}

					res += c;

					esc = false;
				}

				i = x;

				let val;
				let len;

				switch (c) {
					case '"':
						val = Buffer.from(res, "utf8");
						break;
					case '\'':
						val = Buffer.from(res, "hex");
						break;
					case '`':
						len = res.length;
						val = Buffer.alloc(Math.ceil(len / 8));

						for (let i = 0; i < len; i++) {
							val[Math.floor(i / 8)] += parseInt(res[i]) * 2**(7-(i % 8));
						}
						break;
				}

				tokens.push({
					type: 0,
					val,
					len: len || val.length * 8
				});

				ltype = -1;
			} else {
				if (ctype !== 1) {
					token += c;
				}
			}

			esc = false;
		}

		return tokens;
	}

	function intToData(x) {
		let b = Buffer.alloc(4);

		b.writeUInt32LE(x);

		for (let i = 0; i < b.length; i++) {
			if (i !== 0 && b[i] === 0) {
				b = b.subarray(0, i);
				break;
			} else {
				b[i] = reverseByte(b[i]);
			}
		}

		let len = b.length * 8;

		const by = b[b.length - 1];

		for (let i = 0; i < 8; i++) {
			if ((by & (1 << i)) !== 0 || i === 7) {
				len = len - i;
				break;
			}
		}

		return {
			type: 0,
			val: b,
			len: len
		};
	}

	function dataToInt(x) {
		let counter = 0;

		for (let i = 0; i < x.len; i++) {
			counter += ((x.val[Math.floor(i / 8)] & (128 >> (i % 8))) !== 0) * 2**i;
		}

		return counter;
	}

	function grpset(tokens, start = 0) {
		let statements = [];

		let index = 0;

		let branch = null;

		let equals = false;

		let i = start;
		while (i < tokens.length) {
			i++;

			const res = group(tokens, i);

			const t = tokens[res.i];

			i = res.i;

			if (res.branch) {
				switch (t.val) {
					case '=':
						equals = true;
						branch = res.branch;
						break;
					case ';':
					case '}':
						if (!equals) {
							branch = intToData(index);
							index++;
						}

						equals = false;

						statements.push({
							key: branch,
							val: res.branch
						});

						branch = null;

						break;
				}

			}

			if (t.val === '}') {
				return {
					branch: {
						type: 4,
						val: statements
					},
					i
				};
			}
		}

		throw "didn't get to the end of a set!";
	}

	function group(tokens, start = 0) {
		let branch = null;

		function operate(t) {
			if (branch) {
				branch = {
					type: 6,
					a: branch,
					b: t || Null
				};
			} else {
				branch = t;
			}
		}

		let i = start;
		for (; i < tokens.length; i++) {
			const t = tokens[i];

			switch (t.type) {
				case 0:
					operate(t);
					break;
				case 2:
					switch (t.val) {
						case '$':
							operate(t);
							break;
						case ';':
						case '=':
						case ')':
						case '}':
							return {
								branch,
								i
							};
						case '(':
						case '{':
							{
								const res = t.val === '(' ? group(tokens, i + 1) : grpset(tokens, i);

								i = res.i;

								operate(res.branch);
							};
							break;
						case ':':
							{
								let variable;

								if (branch.type === 6) {
									variable = branch.b;

									branch = branch.a;
								} else {
									variable = branch;
									branch = null;
								}

								const res = group(tokens, i + 1);

								i = res.i - 1;

								operate({
									type: 5,
									variable,
									val: res.branch
								});
							};
							break;
					}
					break;
			}
		}

		return {
			branch: branch || Null,
			i
		};
	}

	function addToSet(a, b) {
		const res = mkobj(7, {});

		for (set of [a, b]) {
			for (const l in set.val) {
				for (const n in set.val[l]) {
					res.val[l] = res.val[l] || {};
					res.val[l][n] = set.val[l][n];
				}
			}
		}

		return res;
	}

	const getSet = (s, k) => s.val[k.len]?.[k.val.toString("binary")] || Null;

	const setSet = (s, k, v) => {
		s.val[k.len] = s.val[k.len] || {};
		s.val[k.len][k.val.toString("binary")] = v;
	};

	const bitInByte = (x, i) => (x.val[Math.floor(i / 8)] & (128 >> (i % 8))) << (i % 8);

	const Zero = intToData(0);
	const One = intToData(1);

	function combine(a, b, scope) {
		a = nixeval(a, scope);
		b = nixeval(b, scope);

		switch (a.type) {
			case 0:
				switch (b.type) {
					case 0:
						{
							const len = a.len + b.len;

							const res = Buffer.alloc(Math.ceil(len / 8));
							a.val.copy(res);

							for (let i = 0; i < b.len; i++) {
								res[Math.floor((a.len + i) / 8)] |= bitInByte(b, i) >> ((a.len + i) % 8);
							}

							return {
								type: 0,
								val: res,
								len
							};
						};
						break;
					case 7:
						{
							const from = dataToInt(getSet(b, Zero));
							const to = dataToInt(getSet(b, One));

							const len = to - from;

							const val = Buffer.alloc(Math.ceil(len / 8));

							for (let i = 0; i < len; i++) {
								val[Math.floor(i / 8)] |= bitInByte(a, i + from) >> (i % 8);
							}

							return {
								type: 0,
								val,
								len
							}
						};
					case 8:
						{
							let branch;

							for (let i = 0; i < a.len; i++) {
								const res = b.val(intToData(bitInByte(a, i) / 128));

								branch = branch ? combine(branch, res, scope) : res;
							}

							return branch;
						};
					case 9:
						return intToData(a.len);
				}
				break;
			case 7:
				switch (b.type) {
					case 9:
						{
							const nset = mkobj(7, {});

							let i = 0;
							for (const l in a.val) {
								for (const k in a.val[l]) {
									setSet(nset, intToData(i), mkobj(0, Buffer.from(k, "binary")));
									i++;
								}
							}

							return nset;
						};
						break;
					case 0:
						return getSet(a, b);
					case 7:
						return addToSet(a, b);
					case 8:
						{
							let branch;

							for (const l in a.val) {
								for (const k in a.val[l]) {
									const res = b.val(a.val[l][k]);
									branch = branch ? combine(branch, res, scope) : res;
								}
							}

							return branch;
						};
						break;
				}
				break;
			case 9:
				return intToData({
					9: 0,
					0: 1,
					7: 2,
					8: 3
				}[b.type]);
			case 8:
				return a.val(b);
		}
	}

	function nixevalUnsafe(e, scope = mkobj(7, {})) {
		// as of now, types are as follows:
		// 0: string (adjacent ordinary characters or specifically constructed strings)
		// 2: special tokens (only the scope set character by now)
		// 4: set constructor
		// 5: function constructor
		// 6: combiner
		// 7: set
		// 8: function
		// 9: null

		if (!e) {
			return e;
		}

		switch (e.type) {
			case 2:
				return scope;
			case 4:
				{
					const val = {
						type: 7,
						val: {}
					};

					for (element of e.val) {
						const res = nixeval(element.key, scope);

						setSet(val, res, nixeval(element.val, scope));
					}

					return val;
				};
				break;
			case 5:
				{
					const v = nixeval(e.variable, scope);

					return {
						type: 8,
						val: a => {
							const sobj = mkobj(7, {});

							setSet(sobj, v, a);

							const newScope = addToSet(scope, sobj);

							return nixeval(e.val, newScope);
						}
					};
				};
				break;
			case 6:
				return combine(e.a, e.b, scope);
		}

		return e;
	}

	function nixeval(e, scope) {
		return nixevalUnsafe(e, scope) || Null;
	}

	console.log("---BEGIN EVALUATION---");

	const tokens = tokenise(exp);

	console.log("TOKENS");
	console.dir(tokens, { depth: null });
	console.log();

	const grouped = group(tokens).branch;

	console.log("GROUPED");
	console.dir(grouped, { depth: null });
	console.log();

	console.log("---RETURNING RESULT---");
	return nixeval(grouped);
}

const exp = fs.readFileSync(process.argv[2]).toString()
//const exp = "";

console.dir(nixinter(exp), { depth: null });
