const fs = require('fs');
const path = require('path');
const readline = require('readline');

const OUTPUT_FILE = 'agent_alpha_bundle.txt';
const ALLOWED_EXTENSIONS = ['.js', '.html', '.css', '.json', '.txt', '.md', '.jsx', '.ts', '.tsx', '.glsl', '.vue', '.svelte'];
const MAX_FILE_SIZE = 2 * 1024 * 1024;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Simplified .gitignore parser
function loadGitignore() {
  const patterns = [];
  try {
    const gitignoreContent = fs.readFileSync('.gitignore', 'utf8');
    const lines = gitignoreContent.split('\n');
    
    for (let line of lines) {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        // Remove trailing slash for directories
        if (line.endsWith('/')) {
          line = line.slice(0, -1);
        }
        patterns.push(line);
      }
    }
  } catch (err) {
    // No .gitignore file, that's fine
  }
  return patterns;
}

// Check if a file/directory should be ignored
function shouldIgnore(filePath, patterns) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileName = path.basename(filePath);
  
  for (const pattern of patterns) {
    // Exact match
    if (fileName === pattern || normalizedPath === pattern) {
      return true;
    }
    
    // Wildcard patterns
    if (pattern.includes('*')) {
      const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(fileName) || regex.test(normalizedPath)) {
        return true;
      }
    }
    
    // Directory patterns (if pattern doesn't contain /, it matches any directory with that name)
    if (!pattern.includes('/')) {
      const pathParts = normalizedPath.split('/');
      if (pathParts.includes(pattern)) {
        return true;
      }
    }
  }
  
  return false;
}

function getFiles(dir, fileList = [], gitignorePatterns) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const relativePath = path.relative('.', filePath);
    
    // Check gitignore
    if (shouldIgnore(relativePath, gitignorePatterns) || shouldIgnore(file, gitignorePatterns)) {
      continue;
    }
    
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      getFiles(filePath, fileList, gitignorePatterns);
    } else {
      const ext = path.extname(file).toLowerCase();
      if (ALLOWED_EXTENSIONS.includes(ext) && file !== OUTPUT_FILE && file !== 'alpha_bundler.js') {
        if (stat.size <= MAX_FILE_SIZE) {
          fileList.push({
            path: relativePath,
            name: file,
            size: stat.size,
            dir: path.dirname(relativePath)
          });
        }
      }
    }
  }
  return fileList;
}

function groupByDirectory(files) {
  const groups = {};
  for (const file of files) {
    const dir = file.dir || '.';
    if (!groups[dir]) {
      groups[dir] = [];
    }
    groups[dir].push(file);
  }
  return groups;
}

function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

function startBundler() {
  console.log('\n🔍 Scanning directory (respecting .gitignore)...\n');
  
  const gitignorePatterns = loadGitignore();
  const files = getFiles('.', [], gitignorePatterns);
  
  if (files.length === 0) {
    console.log('❌ No valid code files found.');
    rl.close();
    return;
  }
  
  const groups = groupByDirectory(files);
  const totalSize = files.reduce((sum, f) => sum + f.size, 0);
  
  console.log('📂 Files grouped by directory:\n');
  console.log('='.repeat(60));
  
  let fileIndex = 1;
  const fileMap = {};
  
  for (const [dir, dirFiles] of Object.entries(groups).sort()) {
    console.log(`\n📁 ${dir}/ (${dirFiles.length} files)`);
    for (const file of dirFiles) {
      console.log(`   [${fileIndex}] ${file.name} (${formatSize(file.size)})`);
      fileMap[fileIndex] = file;
      fileIndex++;
    }
  }
  
  console.log('\n' + '='.repeat(60));
  console.log(`\n📊 Summary:`);
  console.log(`   Total files: ${files.length}`);
  console.log(`   Total size: ${formatSize(totalSize)}`);
  console.log(`   Directories: ${Object.keys(groups).length}`);
  
  rl.question('\n💡 Options:\n   • Press ENTER to bundle all files\n   • Type folder names to exclude (comma-separated): e.g., "node_modules,dist,tests"\n   • Type "q" to quit\n\n👉 Your choice: ', (answer) => {
    if (answer.trim().toLowerCase() === 'q') {
      console.log('Cancelled.');
      rl.close();
      return;
    }
    
    let selectedFiles = [...files];
    
    // If user wants to exclude specific folders
    if (answer.trim()) {
      const excludePatterns = answer.split(',').map(s => s.trim().toLowerCase());
      selectedFiles = files.filter(f => {
        const pathLower = f.path.toLowerCase();
        return !excludePatterns.some(pattern =>
          pathLower.includes(pattern.toLowerCase())
        );
      });
    }
    
    if (selectedFiles.length === 0) {
      console.log('❌ No files selected after filtering.');
      rl.close();
      return;
    }
    
    console.log(`\n⚙️ Bundling ${selectedFiles.length} files...\n`);
    
    let output = '';
    let bundledSize = 0;
    
    for (const file of selectedFiles) {
      try {
        const content = fs.readFileSync(file.path, 'utf8');
        bundledSize += content.length;
        
        output += `\n\n<<<<<< FILE_START: ${file.path} >>>>>>\n`;
        output += content;
        output += `\n<<<<<< FILE_END: ${file.path} >>>>>>\n`;
        
        console.log(`  ✅ ${file.path}`);
      } catch (err) {
        console.log(`  ❌ Error: ${file.path} - ${err.message}`);
      }
    }
    
    fs.writeFileSync(OUTPUT_FILE, output, 'utf8');
    
    console.log('\n' + '='.repeat(60));
    console.log(`🎉 SUCCESS!`);
    console.log(`   Output: ${OUTPUT_FILE}`);
    console.log(`   Files bundled: ${selectedFiles.length}`);
    console.log(`   Bundle size: ${formatSize(bundledSize)}`);
    console.log('='.repeat(60) + '\n');
    
    rl.close();
  });
}

startBundler();