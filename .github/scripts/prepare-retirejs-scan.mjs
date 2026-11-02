import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  symlinkSync,
} from "node:fs"
import path from "node:path"

const root = process.cwd()
const scanRoot = process.argv[2]

if (!scanRoot) throw new Error("Provide an empty directory for the Retire.js scan input")
if (existsSync(scanRoot) && readdirSync(scanRoot).length > 0) {
  throw new Error(`Retire.js scan input is not empty: ${scanRoot}`)
}

const scopes = [
  { name: "root", directory: ".", manifest: "package.json" },
  { name: "a2a", directory: "packages/a2a", manifest: "packages/a2a/package.json" },
  { name: "plugin-a2a", directory: "packages/plugin-a2a", manifest: "packages/plugin-a2a/package.json" },
]
const scannedFiles = new Set()
const visitedPackages = new Set()
const rootPath = realpathSync(root)
let packageCount = 0

for (const scope of scopes) {
  const manifest = JSON.parse(readFileSync(path.join(root, scope.manifest), "utf8"))
  for (const dependency of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    const dependencyPath = path.join(root, scope.directory, "node_modules", dependency)
    if (!existsSync(dependencyPath)) {
      if (manifest.optionalDependencies?.[dependency]) continue
      throw new Error(`Missing installed dependency ${dependency} for ${scope.name}`)
    }
    visitPackage(dependency, dependencyPath, path.join(scanRoot, scope.name, "node_modules", dependency))
  }
}

if (scannedFiles.size === 0) throw new Error("Retire.js scan input contains no installed JavaScript files")
console.log(
  `Prepared Retire.js input: ${packageCount} production packages, ${scannedFiles.size} unique JavaScript files`,
)

function visitPackage(dependency, dependencyPath, destination) {
  const packagePath = realpathSync(dependencyPath)
  if (visitedPackages.has(packagePath)) return
  visitedPackages.add(packagePath)
  packageCount++

  const manifestPath = path.join(packagePath, "package.json")
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"))
  visitFiles(packagePath, destination)

  for (const name of Object.keys({ ...manifest.dependencies, ...manifest.optionalDependencies })) {
    const installedPath = resolveDependency(packagePath, name)
    if (!installedPath) {
      if (manifest.optionalDependencies?.[name]) continue
      throw new Error(`Missing installed dependency ${name} required by ${manifest.name ?? dependency}`)
    }
    visitPackage(name, installedPath, path.join(destination, "node_modules", name))
  }
}

function visitFiles(source, destination) {
  for (const entry of readdirSync(source)) {
    const sourcePath = path.join(source, entry)
    const destinationPath = path.join(destination, entry)
    const entryStats = lstatSync(sourcePath)
    const stats = entryStats.isSymbolicLink() ? statSync(sourcePath) : entryStats

    if (stats.isDirectory()) {
      if (entry !== "node_modules" && !entryStats.isSymbolicLink()) visitFiles(sourcePath, destinationPath)
      continue
    }

    if (!stats.isFile() || !entry.endsWith(".js")) continue
    const realFile = realpathSync(sourcePath)
    if (scannedFiles.has(realFile)) continue
    scannedFiles.add(realFile)
    mkdirSync(path.dirname(destinationPath), { recursive: true })
    symlinkSync(realFile, destinationPath)
  }
}

function resolveDependency(fromPackage, dependency) {
  let directory = fromPackage
  while (directory === rootPath || directory.startsWith(`${rootPath}${path.sep}`)) {
    const candidate = path.join(directory, "node_modules", dependency)
    if (existsSync(candidate)) return candidate
    if (directory === rootPath) return
    directory = path.dirname(directory)
  }
}
