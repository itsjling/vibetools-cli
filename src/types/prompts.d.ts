declare module "prompts" {
  export type PromptType =
    | "text"
    | "password"
    | "invisible"
    | "number"
    | "confirm"
    | "list"
    | "toggle"
    | "select"
    | "multiselect"
    | "autocomplete"
    | "date"
    | null;

  export interface Choice {
    title: string;
    value: unknown;
    description?: string;
    selected?: boolean;
    disabled?: boolean;
  }

  export interface PromptObject<Name extends string = string> {
    type: PromptType | ((prev: unknown) => PromptType);
    name: Name;
    message: string;
    initial?: unknown;
    choices?: Choice[];
    hint?: string;
    validate?: (value: unknown) => true | string;
  }

  export default function prompts<
    Answers extends Record<string, unknown> = Record<string, unknown>,
  >(questions: PromptObject | PromptObject[]): Promise<Answers>;
}
