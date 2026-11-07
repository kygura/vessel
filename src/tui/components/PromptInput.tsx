import { Box, Text, useInput } from "ink";
import { borderStyle, type Mode } from "../theme.ts";

export interface PromptInputProps {
  value: string;
  mode: Mode;
  disabled: boolean;
  /** e.g. `resume: ` after pressing R. */
  prefix?: string;
  focused?: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
}

export function PromptInput({ value, mode, disabled, prefix, focused = true, onChange, onSubmit }: PromptInputProps) {
  useInput(
    (input, key) => {
      if (key.return) return onSubmit(value);
      if (key.backspace || key.delete) return onChange(value.slice(0, -1));
      if (key.ctrl || key.meta || key.escape || key.tab || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow) return;
      if (input) onChange(value + input.replace(/[\r\n]+/g, " "));
    },
    { isActive: focused && !disabled },
  );
  return (
    <Box borderStyle={borderStyle()} borderLeft={false} borderRight={false} justifyContent="space-between">
      <Text wrap="truncate-start">
        <Text bold>{">"} </Text>
        {disabled ? (
          <Text dimColor>running... (Esc to abort)</Text>
        ) : (
          <>
            {prefix && <Text dimColor>{prefix}</Text>}
            {value}
            {focused && <Text inverse> </Text>}
          </>
        )}
      </Text>
      <Text dimColor> [{mode}]</Text>
    </Box>
  );
}
