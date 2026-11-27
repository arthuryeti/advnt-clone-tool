import "server-only";

export {
  relaxSchemaNode,
  unwrapNamedObjectText,
} from "@/lib/ai/providers/text/schema-utils";
export type { TextReasoningEffort as ReasoningEffort } from "@/lib/ai/providers/text/types";

export async function unwrapNamedObject({
  text,
}: {
  text: string;
}): Promise<string | null> {
  const { unwrapNamedObjectText } = await import(
    "@/lib/ai/providers/text/schema-utils"
  );
  return unwrapNamedObjectText(text);
}
