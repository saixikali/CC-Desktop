import { memo, useDeferredValue } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import hljs from "highlight.js";
import "highlight.js/styles/github-dark.css";
import { cn } from "../lib/cn.ts";

/** 代码块超过该长度不再做高亮，避免高亮器处理超长文本时长时间占用主线程。 */
const HL_LIMIT = 20_000;

const SAFE_HREF = /^(https?:|mailto:|file:|#)/i;

/**
 * 统一 Markdown 渲染：GFM（表格/任务列表/删除线）、代码块高亮。
 * 代码来自本地会话内容；hljs 输出前会转义 HTML 实体。
 * 流式高频 delta 下用 useDeferredValue 延迟解析，优先保证输入/滚动流畅。
 */
export const Markdown = memo(function Markdown({
  content,
  className,
}: {
  content: string;
  className?: string;
}) {
  const deferred = useDeferredValue(content);
  return (
    <div className={cn("selectable markdown-body text-[13px] leading-relaxed", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          code(props: any) {
            const cls = typeof props.className === "string" ? props.className : undefined;
            const rest: Record<string, unknown> = { ...props };
            delete rest.node;
            const children = props.children;
            const text = String(children ?? "");
            const matched = /language-([\w-]+)/.exec(cls ?? "");
            const isBlock = text.includes("\n");
            if (isBlock) {
              const lang = matched?.[1];
              const body = text.replace(/\n$/, "");
              let html = "";
              try {
                if (body.length > HL_LIMIT) {
                  html = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
                } else if (lang && hljs.getLanguage(lang)) {
                  html = hljs.highlight(body, { language: lang }).value;
                } else {
                  html = hljs.highlightAuto(body).value;
                }
              } catch {
                // hljs 异常时绝不允许原文直接进 innerHTML，统一实体转义。
                html = body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
              }
              return (
                <code
                  className={cn("hljs font-mono text-[12px]", cls)}
                  dangerouslySetInnerHTML={{ __html: html }}
                />
              );
            }
            return (
              <code
                className={cn(
                  "rounded bg-surface-3 px-1.5 py-0.5 font-mono text-[12px] text-text",
                  cls,
                )}
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                {...(rest as any)}
              >
                {children}
              </code>
            );
          },
          a({ children, href }) {
            const safe = typeof href === "string" && SAFE_HREF.test(href);
            return (
              <a
                href={safe ? href : undefined}
                className="text-accent underline-offset-2 hover:underline"
                target="_blank"
                rel="noreferrer"
              >
                {children}
              </a>
            );
          },
          pre({ children }) {
            return (
              <pre className="my-2 overflow-x-auto rounded-lg border border-border bg-black/20 p-3">
                {children}
              </pre>
            );
          },
          table({ children }) {
            return (
              <div className="my-2 overflow-x-auto">
                <table className="border-collapse text-[12px]">{children}</table>
              </div>
            );
          },
          th({ children }) {
            return <th className="border border-border bg-surface-2 px-2.5 py-1">{children}</th>;
          },
          td({ children }) {
            return <td className="border border-border px-2.5 py-1">{children}</td>;
          },
        }}
      >
        {deferred}
      </ReactMarkdown>
    </div>
  );
});
