import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyCommand } from "./commandClassifier.js";

test("classifies common read commands as read", () => {
    for (const command of ["pwd", "ls -la", "git status", "rg TODO src", "Get-Content file.txt"]) {
        assert.equal(classifyCommand(command), "read", command);
    }
});

test("classifies delete commands and compound commands by their riskiest segment", () => {
    for (const command of ["rm -rf build", "del /s output", "Remove-Item -Recurse build", "git clean -fdx", "git reset --hard HEAD", "pwd && rm -rf build", "git status; del file.txt"]) {
        assert.equal(classifyCommand(command), "delete", command);
    }
});

test("classifies redirections and file-writing commands as write", () => {
    for (const command of ["echo hello > output.txt", "cat input >> output.txt", "Get-Content input | Out-File output", "Set-Content output value", "pwd && echo ok > output"]) {
        assert.equal(classifyCommand(command), "write", command);
    }
});

test("classifies dynamic evaluation, substitutions, backticks and script execution as exec", () => {
    for (const command of ["eval 'pwd'", "iex 'Get-ChildItem'", "Invoke-Expression $script", "echo $(pwd)", "echo `pwd`", "bash ./task.sh", "python -c 'print(1)'", "node script.js", "powershell -File task.ps1"]) {
        assert.equal(classifyCommand(command), "exec", command);
    }
    assert.equal(classifyCommand("echo $(rm -rf build)"), "delete");
});

test("classifies recognizable outbound actions as send and unknown commands as exec", () => {
    for (const command of ["git push origin main", "curl -X POST https://example.test", "curl --data x https://example.test", "Invoke-RestMethod -Method Post -Uri https://example.test", "scp file user@host:/tmp", "npm publish"]) {
        assert.equal(classifyCommand(command), "send", command);
    }
    assert.equal(classifyCommand("curl https://example.test"), "exec");
    assert.equal(classifyCommand("custom-tool --flag"), "exec");
    assert.equal(classifyCommand("git status & rm -rf build"), "delete");
    assert.equal(classifyCommand("curl -X POST https://example.test > response.txt"), "send");
    assert.equal(classifyCommand("rm -rf build; curl -X POST https://example.test"), "send");
    assert.equal(classifyCommand("  "), "exec");
});