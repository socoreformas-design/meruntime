import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { copyFile, cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const metadata = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
const version = process.versions.node;
const archiveName = `node-v${version}-win-x64.zip`;
const releaseUrl = `https://nodejs.org/dist/v${version}`;
const outputDir = join(root, "dist", "windows");
const installer = join(outputDir, `MeRuntime-Setup-${metadata.version}-win-x64.exe`);
const work = await mkdtemp(join(tmpdir(), "meruntime-windows-"));
const candidateInstaller = join(work, `MeRuntime-Setup-${metadata.version}-win-x64.exe`);

if (process.platform !== "win32" || process.arch !== "x64") {
    throw new Error("The Windows installer must be built on Windows x64.");
}

try {
    const checksumsResponse = await fetch(`${releaseUrl}/SHASUMS256.txt`);
    if (!checksumsResponse.ok) throw new Error(`Could not download Node.js checksums (${checksumsResponse.status}).`);
    const checksums = await checksumsResponse.text();
    const checksumLine = checksums.split(/\r?\n/).find((line) => line.endsWith(`  ${archiveName}`));
    if (!checksumLine) throw new Error(`No checksum found for ${archiveName}.`);

    const archiveResponse = await fetch(`${releaseUrl}/${archiveName}`);
    if (!archiveResponse.ok) throw new Error(`Could not download ${archiveName} (${archiveResponse.status}).`);
    const archive = Buffer.from(await archiveResponse.arrayBuffer());
    const expectedHash = checksumLine.split(/\s+/)[0];
    const actualHash = createHash("sha256").update(archive).digest("hex");
    if (actualHash !== expectedHash) throw new Error("Node.js archive checksum mismatch.");

    const archivePath = join(work, archiveName);
    const extracted = join(work, "node");
    const nodeRoot = join(extracted, `node-v${version}-win-x64`);
    const payloadRoot = join(work, "payload");
    const appRoot = join(payloadRoot, "app");
    const runtimeRoot = join(payloadRoot, "runtime");
    const sourceRoot = join(work, "iexpress");
    const distRoot = join(appRoot, "dist");

    await writeFile(archivePath, archive);
    await mkdir(extracted, { recursive: true });
    execFileSync("tar.exe", ["-xf", archivePath, "-C", extracted], { stdio: "inherit" });
    await mkdir(distRoot, { recursive: true });
    await mkdir(runtimeRoot, { recursive: true });
    await mkdir(sourceRoot, { recursive: true });

    await build({
        absWorkingDir: root,
        entryPoints: ["packages/cli/src/cli.ts"],
        outfile: join(distRoot, "cli.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20",
        packages: "bundle",
        legalComments: "none",
    });

    await copyFile(join(nodeRoot, "node.exe"), join(runtimeRoot, "node.exe"));
    await copyFile(join(nodeRoot, "LICENSE"), join(runtimeRoot, "NODE-LICENSE"));
    await copyFile(join(root, "LICENSE.md"), join(appRoot, "LICENSE.md"));
    await copyFile(join(root, "README.es.md"), join(appRoot, "LEEME.md"));
    await copyFile(join(root, "scripts", "windows", "launch.vbs"), join(payloadRoot, "launch.vbs"));
    await cp(join(root, "examples"), join(appRoot, "examples"), { recursive: true });
    await copyFile(join(root, "scripts", "windows", "install.ps1"), join(sourceRoot, "install.ps1"));
    await writeFile(join(sourceRoot, "payload.zip"), "");

    const payloadArchive = join(sourceRoot, "payload.zip");
    const compress = `Compress-Archive -Path '${payloadRoot.replace(/'/g, "''")}\\*' -DestinationPath '${payloadArchive.replace(/'/g, "''")}' -CompressionLevel Optimal -Force`;
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", compress], { stdio: "inherit" });
    await writeFile(join(sourceRoot, "install.cmd"), "@echo off\r\npowershell.exe -NoProfile -ExecutionPolicy Bypass -File \"%~dp0install.ps1\"\r\nexit /b %ERRORLEVEL%\r\n");

    const sedPath = join(work, "meruntime.sed");
    const sed = [
        "[Version]",
        "Class=IEXPRESS",
        "SEDVersion=3",
        "[Options]",
        "PackagePurpose=InstallApp",
        "ShowInstallProgramWindow=1",
        "HideExtractAnimation=1",
        "UseLongFileName=1",
        "InsideCompressed=1",
        "CAB_FixedSize=0",
        "CAB_ResvCodeSigning=0",
        "RebootMode=N",
        "InstallPrompt=%InstallPrompt%",
        "DisplayLicense=%DisplayLicense%",
        "FinishMessage=%FinishMessage%",
        `TargetName=${candidateInstaller}`,
        "FriendlyName=Me Runtime Setup",
        "AppLaunched=install.cmd",
        "PostInstallCmd=<None>",
        "AdminQuietInstCmd=<None>",
        "UserQuietInstCmd=<None>",
        "SourceFiles=SourceFiles",
        "[Strings]",
        "InstallPrompt=Install Me Runtime for this Windows account?",
        "DisplayLicense=",
        "FinishMessage=Me Runtime is installed. Its setup window is opening.",
        'FILE0="payload.zip"',
        'FILE1="install.cmd"',
        'FILE2="install.ps1"',
        "[SourceFiles]",
        `SourceFiles0=${sourceRoot}`,
        "[SourceFiles0]",
        "%FILE0%=",
        "%FILE1%=",
        "%FILE2%=",
        "",
    ].join("\r\n");
    await writeFile(sedPath, sed, "ascii");

    await mkdir(outputDir, { recursive: true });
    execFileSync("iexpress.exe", ["/N", "/Q", sedPath], { stdio: "inherit" });
    const builtInstaller = await readFile(candidateInstaller);
    if (builtInstaller.length < 1_000_000) throw new Error("The installer output is unexpectedly small.");
    const peOffset = builtInstaller.readUInt32LE(0x3c);
    if (builtInstaller.subarray(0, 2).toString() !== "MZ" || peOffset + 4 > builtInstaller.length || builtInstaller.subarray(peOffset, peOffset + 4).toString("hex") !== "50450000") {
        throw new Error("The installer output is not a valid Windows PE executable.");
    }

    await copyFile(candidateInstaller, installer);
    console.log(`Installer: ${installer}`);
    console.log(`Size: ${(builtInstaller.length / 1024 / 1024).toFixed(1)} MB`);
    console.log(`SHA-256: ${createHash("sha256").update(builtInstaller).digest("hex")}`);
} finally {
    await rm(work, { recursive: true, force: true });
}