/**
 * Remark plugin that rewrites ```mermaid fenced code blocks into
 * `<Mermaid>` MDX JSX elements **before** the tree reaches
 * rehype-shiki or the RSC compile pass.
 *
 * Why not just author `<Mermaid code={…}>` in MDX? Because
 * `next-mdx-remote/rsc` serialises props across the RSC boundary
 * and multi-line template literals inside JSX attributes — and
 * even string children — can arrive as `undefined` on the client
 * component. Converting the fence at the remark stage sidesteps
 * the serialiser: the source lands as a plain `code=""` string
 * attribute that round-trips reliably.
 *
 * Intentionally typed loosely — `mdast` / `unified` /
 * `unist-util-visit` are transitive deps of `next-mdx-remote` and
 * aren't listed in our own `package.json`, so pulling their types
 * in would add fragile dependency bookkeeping for a ten-line
 * plugin.
 *
 * @module
 */

interface MdastNode {
  type: string;
  lang?: string | null;
  value?: string;
  children?: MdastNode[];
}

interface MdxJsxAttribute {
  type: 'mdxJsxAttribute';
  name: string;
  value: string;
}

interface MdxJsxFlowElement {
  type: 'mdxJsxFlowElement';
  name: string;
  attributes: MdxJsxAttribute[];
  children: [];
}

function walk(node: MdastNode): void {
  const children = node.children;
  if (children === undefined) return;
  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];
    if (child === undefined) continue;
    if (child.type === 'code' && child.lang === 'mermaid' && typeof child.value === 'string') {
      const replacement: MdxJsxFlowElement = {
        type: 'mdxJsxFlowElement',
        name: 'Mermaid',
        attributes: [
          {
            type: 'mdxJsxAttribute',
            name: 'code',
            value: child.value,
          },
        ],
        children: [],
      };
      children[i] = replacement as unknown as MdastNode;
      continue;
    }
    walk(child);
  }
}

export function remarkMermaid(): (tree: MdastNode) => void {
  return (tree) => walk(tree);
}
