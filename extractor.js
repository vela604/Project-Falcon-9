const fs = require('fs');
const path = require('path');
const readline = require('readline');

// --- CONFIGURATION ---
const OUTPUT_FILE = 'agent_alpha_bundle.txt';
// Only bundle text/code files. Ignore images, binaries, etc.
const ALLOWED_EXTENSIONS = ['.js', '.html', '.css', '.json', '.txt', '.md', '.jsx', '.ts', '.tsx', '.glsl'];
// Directories to completely ignore
const IGNORE_DIRS = ['node_modules', '.git', '.vscode', 'dist', 'build'];
// Max size per file (e.g., 2MB) to prevent accidental massive bundles
const MAX_FILE_SIZE = 2 * 1024 * 1024;

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

function getFiles(dir, fileList = []) {
  const files = fs.readdirSync(dir);
  for (const file of files) {
    const filePath = path.join(dir, file);
    const stat = fs.statSync(filePath);
    
    if (stat.isDirectory()) {
      if (!IGNORE_DIRS.includes(file)) {
        getFiles(filePath, fileList);
      }
    } else {
      const ext = path.extname(file).toLowerCase();
      if (ALLOWED_EXTENSIONS.includes(ext) && file !== OUTPUT_FILE && file !== 'alpha_bundler.js') {
        if (stat.size <= MAX_FILE_SIZE) {
          fileList.push({ path: filePath, name: file, size: stat.size });
        } else {
          console.log(`[SKIPPED] ${file} is too large (> ${MAX_FILE_SIZE/1024/1024}MB)`);
        }
      }
    }
  }
  return fileList;
}

function startBundler() {
  console.log('\n🔍 Scanning directory for code files...\n');
  const files = getFiles('.');
  
  if (files.length === 0) {
    console.log('❌ No valid code files found in this directory.');
    rl.close();
    return;
  }
  
  console.log('📂 Available Files:');
  console.log('-'.repeat(50));
  files.forEach((f, i) => {
    const sizeKB = (f.size / 1024).toFixed(1);
    console.log(`  [${i + 1}] ${f.path} (${sizeKB} KB)`);
  });
  console.log('-'.repeat(50));
  
  rl.question('\n👉 Select files to bundle (e.g., "1,3,5" or type "all"): ', (answer) => {
    let selectedIndices = [];
    
    if (answer.trim().toLowerCase() === 'all') {
      selectedIndices = files.map((_, i) => i);
    } else {
      const choices = answer.split(',').map(s => parseInt(s.trim(), 10));
      selectedIndices = choices.filter(n => !isNaN(n) && n >= 1 && n <= files.length).map(n => n - 1);
    }
    
    if (selectedIndices.length === 0) {
      console.log('❌ No valid files selected. Exiting.');
      rl.close();
      return;
    }
    
    console.log(`\n⚙️ Bundling ${selectedIndices.length} files into ${OUTPUT_FILE}...\n`);
    
    let output = '';
    let totalSize = 0;
    
    for (const index of selectedIndices) {
      const file = files[index];
      try {
        const content = fs.readFileSync(file.path, 'utf8');
        totalSize += content.length;
        
        // Using highly distinct delimiters so I can parse it flawlessly
        output += `\n\n<<<<<< FILE_START: ${file.path} >>>>>>\n`;
        output += content;
        output += `\n<<<<<< FILE_END: ${file.path} >>>>>>\n`;
        
        console.log(`  ✅ Added: ${file.path}`);
      } catch (err) {
        output += `\n\n<<<<<< FILE_START: ${file.path} >>>>>>\n`;
        output += `[ERROR READING FILE: ${err.message}]\n`;
        output += `<<<<<< FILE_END: ${file.path} >>>>>>\n`;
        console.log(`  ❌ Error reading: ${file.path}`);
      }
    }
    
    fs.writeFileSync(OUTPUT_FILE, output, 'utf8');
    const finalSizeMB = (Buffer.byteLength(output, 'utf8') / 1024 / 1024).toFixed(2);
    
    console.log('\n' + '='.repeat(50));
    console.log(`🎉 SUCCESS! Bundle created: ${OUTPUT_FILE}`);
    console.log(`📊 Total files: ${selectedIndices.length} | Total size: ${finalSizeMB} MB`);
    console.log('='.repeat(50) + '\n');
    
    rl.close();
  });
}

startBundler();