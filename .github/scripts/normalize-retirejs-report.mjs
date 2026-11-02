import { readFileSync, writeFileSync } from "node:fs"
import path from "node:path"

const [reportPath, scanRoot] = process.argv.slice(2)
if (!reportPath || !scanRoot) throw new Error("Provide the Retire.js report and scan-root paths")

const report = JSON.parse(readFileSync(reportPath, "utf8"))
const root = path.resolve(scanRoot)
for (const finding of report.data) {
  const file = path.relative(root, path.resolve(finding.file))
  if (!file || file === ".." || file.startsWith(`..${path.sep}`) || path.isAbsolute(file)) {
    throw new Error(`Retire.js returned a finding outside the scan root: ${finding.file}`)
  }
  finding.file = file.split(path.sep).join("/")
}

writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`)
