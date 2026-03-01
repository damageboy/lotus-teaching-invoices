import { ParseWarning, WarningCode } from "../types.js";

const LABELS: Record<WarningCode, string> = {
  NO_SEPARATOR:          'Events missing "/" separator',
  MISSING_CLASS_TYPE:    'Events with missing class type',
  UNKNOWN_STUDIO:        'Unknown studios (not in config)',
  MISSING_STUDENT_COUNT: 'Events missing student count (defaulted to 0)',
  ZERO_STUDENTS:         'Classes skipped due to zero students',
};

export function printWarningReport(warnings: ParseWarning[]): void {
  if (warnings.length === 0) return;

  const groups = new Map<WarningCode, ParseWarning[]>();
  for (const w of warnings) {
    const group = groups.get(w.code) ?? [];
    group.push(w);
    groups.set(w.code, group);
  }

  console.error('\n--- Unmatched Events Report ---');

  for (const [code, group] of groups) {
    console.error(`\n${LABELS[code]} (${group.length}):`);

    if (code === 'UNKNOWN_STUDIO') {
      // Group by studio name and list their class types
      const byStudio = new Map<string, string[]>();
      for (const w of group) {
        const studio = w.studio!;
        const classType = w.event.slice(w.event.indexOf('/') + 1).trim();
        const list = byStudio.get(studio) ?? [];
        list.push(classType);
        byStudio.set(studio, list);
      }
      for (const [studio, classTypes] of byStudio) {
        console.error(`  • ${studio}: ${classTypes.join(', ')}`);
      }
    } else {
      for (const w of group) {
        const datePart = w.date ? ` [${w.date}]` : '';
        console.error(`  • "${w.event}"${datePart}`);
      }
    }
  }

  console.error('');
}
