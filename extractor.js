const fs = require('fs');
const path = require('path');
const readline = require('readline');

// Configuration
const OUTPUT_FILE = 'agent_alpha_bundle.txt';
const ALLOWED_EXTENSIONS = ['.js', '.html', '.css', '.json', '.txt', '.md', '.jsx', '.ts', '.tsx', '.glsl', '.vue', '.svelte'];
const MAX_FILE_SIZE = 2 * 1024 * 1024; // 2MB

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

// Load .gitignore patterns
function loadGitignore() {
  const patterns = [];
  try {
    const content = fs.readFileSync('.gitignore', 'utf8');
    const lines = content.split('\n');
    
    for (let line of lines) {
      line = line.trim();
      if (line && !line.startsWith('#')) {
        if (line.endsWith('/')) line = line.slice(0, -1);
        patterns.push(line);
      }
    }
  } catch (err) {
    // No .gitignore, that's fine
  }
  return patterns;
}

// Check if path should be ignored
function shouldIgnore(filePath, patterns) {
  const normalizedPath = filePath.replace(/\\/g, '/');
  const fileName = path.basename(filePath);
  
  for (const pattern of patterns) {
    if (fileName === pattern || normalizedPath === pattern) return true;
    
    if (pattern.includes('*')) {
      const regexPattern = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*')
        .replace(/\?/g, '.');
      const regex = new RegExp(`^${regexPattern}$`);
      if (regex.test(fileName) || regex.test(normalizedPath)) return true;
    }
    
    if (!pattern.includes('/')) {
      const pathParts = normalizedPath.split('/');
      if (pathParts.includes(pattern)) return true;
    }
  }
  
  return false;
}

// Recursively get all valid files
function getFiles(dir, fileList = [], gitignorePatterns) {
  const files = fs.readdirSync(dir);
  
  for (const file of files) {
    const filePath = path.join(dir, file);
    const relativePath = path.relative('.', filePath);
    
    if (shouldIgnore(relativePath, gitignorePatterns) || shouldIgnore(file, gitignorePatterns)) {
      continue;
    }
    
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      getFiles(filePath, fileList, gitignorePatterns);
    } else {
      const ext = path.extname(file).toLowerCase();
      if (ALLOWED_EXTENSIONS.includes(ext) && file !== OUTPUT_FILE && file !== 'extractor.js') {
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

// Group files by directory
function groupByDirectory(files) {
  const groups = {};
  for (const file of files) {
    const dir = file.dir || '.';
    if (!groups[dir]) groups[dir] = [];
    groups[dir].push(file);
  }
  return groups;
}

// Format file size
function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
}

// Parse user selection
function parseSelection(input, totalFiles) {
  const selection = {
    mode: 'none', // 'all', 'numbers', 'exclude', 'quit'
    numbers: [],
    excludePatterns: []
  };
  
  const trimmed = input.trim();
  
  if (!trimmed) {
    selection.mode = 'all';
    return selection;
  }
  
  if (trimmed.toLowerCase() === 'q' || trimmed.toLowerCase() === 'quit') {
    selection.mode = 'quit';
    return selection;
  }
  
  // Check if it's comma-separated numbers
  const parts = trimmed.split(',').map(s => s.trim());
  const allNumbers = parts.every(p => /^\d+$/.test(p));
  
  if (allNumbers && parts.length > 0) {
    selection.mode = 'numbers';
    selection.numbers = parts.map(p => parseInt(p, 10)).filter(n => n >= 1 && n <= totalFiles);
    return selection;
  }
  
  // Otherwise treat as folder exclusion patterns
  selection.mode = 'exclude';
  selection.excludePatterns = parts.map(p => p.toLowerCase());
  return selection;
}

// Main bundler logic
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
  console.log('='.repeat(70));
  
  let fileIndex = 1;
  
  for (const [dir, dirFiles] of Object.entries(groups).sort()) {
    console.log(`\n📁 ${dir}/ (${dirFiles.length} files)`);
    for (const file of dirFiles) {
      console.log(`   [${fileIndex}] ${file.name} (${formatSize(file.size)})`);
      file.index = fileIndex;
      fileIndex++;
    }
  }
  
  console.log('\n' + '='.repeat(70));
  console.log(`\n📊 Summary:`);
  console.log(`   Total files: ${files.length}`);
  console.log(`   Total size: ${formatSize(totalSize)}`);
  console.log(`   Directories: ${Object.keys(groups).length}`);
  
  rl.question('\n💡 Selection Options:\n   • ENTER → bundle all files\n   • Numbers → select specific files (e.g., "1,5,12")\n   • Folder names → exclude folders (e.g., "tests,docs")\n   • "q" → quit\n\n👉 Your choice: ', (answer) => {
    const selection = parseSelection(answer, files.length);
    
    if (selection.mode === 'quit') {
      console.log('Cancelled.');
      rl.close();
      return;
    }
    
    let selectedFiles = [];
    
    if (selection.mode === 'all') {
      selectedFiles = [...files];
    } else if (selection.mode === 'numbers') {
      if (selection.numbers.length === 0) {
        console.log('❌ No valid file numbers selected.');
        rl.close();
        return;
      }
      selectedFiles = files.filter(f => selection.numbers.includes(f.index));
    } else if (selection.mode === 'exclude') {
      selectedFiles = files.filter(f => {
        const pathLower = f.path.toLowerCase();
        return !selection.excludePatterns.some(pattern =>
          pathLower.includes(pattern.toLowerCase())
        );
      });
    }
    
    if (selectedFiles.length === 0) {
      console.log('❌ No files selected after filtering.');
      rl.close();
      return;
    }
    
    const selectedSize = selectedFiles.reduce((sum, f) => sum + f.size, 0);
    
    console.log(`\n⚙️ Bundling ${selectedFiles.length} files (${formatSize(selectedSize)})...\n`);
    
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
    
    console.log('\n' + '='.repeat(70));
    console.log(`🎉 SUCCESS!`);
    console.log(`   Output: ${OUTPUT_FILE}`);
    console.log(`   Files bundled: ${selectedFiles.length}`);
    console.log(`   Bundle size: ${formatSize(bundledSize)}`);
    console.log('='.repeat(70) + '\n');
    
    rl.close();
  });
}

startBundler();