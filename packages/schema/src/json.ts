/** Parse JSON and reject repeated object keys before their earlier values are lost. */
export function parseJsonWithUniqueKeys(source: string): unknown {
    const value: unknown = JSON.parse(source);
    const containers: Array<{ type: "object" | "array"; expectingKey: boolean; keys: Set<string> }> = [];

    for (let index = 0; index < source.length;) {
        const character = source[index];
        if (/\s/.test(character)) {
            index++;
            continue;
        }
        if (character === '"') {
            const start = index++;
            while (index < source.length) {
                if (source[index] === "\\") index += 2;
                else if (source[index++] === '"') break;
            }
            const container = containers.at(-1);
            if (container?.type === "object" && container.expectingKey) {
                const key = JSON.parse(source.slice(start, index)) as string;
                if (container.keys.has(key)) throw new SyntaxError(`Duplicate JSON object key: ${JSON.stringify(key)}`);
                container.keys.add(key);
                container.expectingKey = false;
            }
            continue;
        }
        if (character === "{") {
            containers.push({ type: "object", expectingKey: true, keys: new Set() });
            index++;
            continue;
        }
        if (character === "[") {
            containers.push({ type: "array", expectingKey: false, keys: new Set() });
            index++;
            continue;
        }
        if (character === "}" || character === "]") {
            containers.pop();
            index++;
            continue;
        }
        if (character === "," && containers.at(-1)?.type === "object") containers.at(-1)!.expectingKey = true;
        index++;
    }

    return value;
}