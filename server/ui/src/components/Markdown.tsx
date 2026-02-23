import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { PrismLight as SyntaxHighlighter, oneDark } from "@/lib/syntax";
import type { ComponentPropsWithoutRef } from "react";

interface Props {
  children: string;
}

export function Markdown({ children }: Props) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={{
        code({ className, children: codeChildren, ...props }: ComponentPropsWithoutRef<"code">) {
          const match = /language-(\w+)/.exec(className || "");
          const isInline = !match && !String(codeChildren).includes("\n");
          if (isInline) {
            return (
              <code className="px-1.5 py-0.5 rounded bg-secondary text-[0.8125rem] font-mono" {...props}>
                {codeChildren}
              </code>
            );
          }
          return (
            <SyntaxHighlighter
              style={oneDark}
              language={match?.[1] ?? "text"}
              PreTag="div"
              customStyle={{ margin: "0.5rem 0", borderRadius: "0.375rem", fontSize: "0.8125rem" }}
            >
              {String(codeChildren).replace(/\n$/, "")}
            </SyntaxHighlighter>
          );
        },
        pre({ children: preChildren }) {
          return <>{preChildren}</>;
        },
        p({ children: pChildren }) {
          return <p className="mb-2 last:mb-0 leading-relaxed">{pChildren}</p>;
        },
        ul({ children: ulChildren }) {
          return <ul className="mb-2 last:mb-0 pl-5 list-disc space-y-1">{ulChildren}</ul>;
        },
        ol({ children: olChildren }) {
          return <ol className="mb-2 last:mb-0 pl-5 list-decimal space-y-1">{olChildren}</ol>;
        },
        li({ children: liChildren }) {
          return <li className="leading-relaxed">{liChildren}</li>;
        },
        h1({ children: hChildren }) {
          return <h1 className="text-lg font-bold mb-2 mt-4 first:mt-0">{hChildren}</h1>;
        },
        h2({ children: hChildren }) {
          return <h2 className="text-base font-bold mb-2 mt-3 first:mt-0">{hChildren}</h2>;
        },
        h3({ children: hChildren }) {
          return <h3 className="text-sm font-bold mb-1.5 mt-2 first:mt-0">{hChildren}</h3>;
        },
        blockquote({ children: bqChildren }) {
          return <blockquote className="border-l-2 border-border pl-3 my-2 text-muted-foreground italic">{bqChildren}</blockquote>;
        },
        a({ href, children: aChildren }) {
          return <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{aChildren}</a>;
        },
        table({ children: tChildren }) {
          return (
            <div className="overflow-x-auto my-2">
              <table className="w-full border-collapse text-sm">{tChildren}</table>
            </div>
          );
        },
        th({ children: thChildren }) {
          return <th className="border border-border px-3 py-1.5 text-left font-semibold bg-secondary">{thChildren}</th>;
        },
        td({ children: tdChildren }) {
          return <td className="border border-border px-3 py-1.5">{tdChildren}</td>;
        },
        hr() {
          return <hr className="my-3 border-border" />;
        },
      }}
    >
      {children}
    </ReactMarkdown>
  );
}
