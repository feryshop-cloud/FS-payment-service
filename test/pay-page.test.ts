import { describe, expect, it } from "vitest";
import { jsString } from "../src/pay-page";

describe("jsString", () => {
	describe("normal values produce valid JSON", () => {
		it("string", () => {
			expect(jsString("hello")).toBe('"hello"');
		});

		it("number", () => {
			expect(jsString(42)).toBe("42");
		});

		it("zero", () => {
			expect(jsString(0)).toBe("0");
		});

		it("boolean true", () => {
			expect(jsString(true)).toBe("true");
		});

		it("boolean false", () => {
			expect(jsString(false)).toBe("false");
		});

		it("null", () => {
			expect(jsString(null)).toBe("null");
		});

		it("undefined throws (JSON.stringify returns undefined, not a string)", () => {
			expect(() => jsString(undefined)).toThrow(TypeError);
		});

		it("plain object", () => {
			const result = jsString({ a: 1, b: "two" });
			expect(result).toBe('{"a":1,"b":"two"}');
		});

		it("array", () => {
			expect(jsString([1, 2, 3])).toBe("[1,2,3]");
		});

		it("nested object", () => {
			const result = jsString({ key: { nested: true } });
			expect(result).toBe('{"key":{"nested":true}}');
		});

		it("empty string", () => {
			expect(jsString("")).toBe('""');
		});

		it("empty object", () => {
			expect(jsString({})).toBe("{}");
		});

		it("empty array", () => {
			expect(jsString([])).toBe("[]");
		});
	});

	describe("escapes </script> to prevent breakout", () => {
		it("escapes < in </script>", () => {
			const result = jsString("</script>");
			expect(result).not.toContain("<");
			expect(result).not.toContain(">");
			expect(result).toContain("\\u003c");
			expect(result).toContain("\\u003e");
		});

		it("escapes closing script tag within a larger string", () => {
			const result = jsString("hello</script><script>alert(1)</script>world");
			expect(result).not.toContain("</script>");
			expect(result).not.toContain("<script>");
			expect(result).toContain("\\u003c/script\\u003e");
			expect(result).toContain("\\u003cscript\\u003e");
		});

		it("escapes uppercase SCRIPT tags angle brackets", () => {
			const result = jsString("</SCRIPT>");
			expect(result).not.toContain("<");
			expect(result).not.toContain(">");
		});
	});

	describe("escapes <!-- (HTML comment)", () => {
		it("escapes angle brackets in HTML comment", () => {
			const result = jsString("<!-- comment -->");
			expect(result).not.toContain("<");
			expect(result).not.toContain(">");
			expect(result).toContain("\\u003c");
			expect(result).toContain("\\u003e");
		});
	});

	describe("escapes < and > in general", () => {
		it("escapes lone <", () => {
			const result = jsString("a < b");
			expect(result).not.toContain("<");
			expect(result).toContain("\\u003c");
		});

		it("escapes lone >", () => {
			const result = jsString("a > b");
			expect(result).not.toContain(">");
			expect(result).toContain("\\u003e");
		});

		it("escapes HTML tags", () => {
			const result = jsString("<div onclick='xss'>hello</div>");
			expect(result).not.toContain("<div");
			expect(result).not.toContain("</div>");
		});
	});

	describe("escapes Unicode line/paragraph separators", () => {
		it("escapes U+2028 (line separator)", () => {
			const result = jsString("line1\u2028line2");
			expect(result).not.toContain("\u2028");
			expect(result).toContain("\\u2028");
		});

		it("escapes U+2029 (paragraph separator)", () => {
			const result = jsString("para1\u2029para2");
			expect(result).not.toContain("\u2029");
			expect(result).toContain("\\u2029");
		});

		it("escapes both separators in same string", () => {
			const result = jsString("a\u2028b\u2029c");
			expect(result).not.toContain("\u2028");
			expect(result).not.toContain("\u2029");
		});
	});

	describe("edge cases with special characters", () => {
		it("preserves newlines as JSON escape sequences", () => {
			const result = jsString("line1\nline2");
			expect(result).toBe('"line1\\nline2"');
		});

		it("preserves tabs as JSON escape sequences", () => {
			const result = jsString("col1\tcol2");
			expect(result).toBe('"col1\\tcol2"');
		});

		it("escapes double quotes via JSON.stringify", () => {
			const result = jsString('say "hello"');
			expect(result).toBe('"say \\"hello\\""');
		});

		it("handles backslashes", () => {
			const result = jsString("path\\to\\file");
			expect(result).toBe('"path\\\\to\\\\file"');
		});

		it("handles mixed dangerous content", () => {
			const result = jsString('</script><img onerror="alert(1)">\u2028\u2029');
			expect(result).not.toContain("<");
			expect(result).not.toContain(">");
			expect(result).not.toContain("\u2028");
			expect(result).not.toContain("\u2029");
		});

		it("result is safe to embed inside <script> tag", () => {
			// The key invariant: the output must never contain a literal </
			// sequence that could close a <script> block.
			const dangerous = [
				"</script>",
				"</Script>",
				"</SCRIPT>",
				"</scr" + "ipt>",
				"<!--",
				"<![CDATA[",
			];
			for (const input of dangerous) {
				const result = jsString(input);
				expect(result, `input: ${input}`).not.toContain("</");
			}
		});

		it("output is parseable JSON after unescaping", () => {
			const input = { url: "https://x.com/</script>", note: "a\u2028b" };
			const raw = jsString(input);
			// Replace the unicode escapes back so JSON.parse can read it
			const restored = raw
				.replace(/\\u003c/g, "<")
				.replace(/\\u003e/g, ">")
				.replace(/\\u2028/g, "\u2028")
				.replace(/\\u2029/g, "\u2029");
			expect(() => JSON.parse(restored)).not.toThrow();
			expect(JSON.parse(restored)).toEqual(input);
		});
	});
});
