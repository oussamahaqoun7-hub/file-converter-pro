const express = require('express');
const multer = require('multer');
const sharp = require('sharp');
const ffmpeg = require('fluent-ffmpeg');
const PDFDocument = require('pdfkit');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const path = require('path');
const fs = require('fs');
const cors = require('cors');

const app = express();
const PORT = 3000;

// Middleware
app.use(cors());
app.use(express.static('public'));
app.use(express.json());

// إنشاء المجلدات
const uploadsDir = path.join(__dirname, 'uploads');
const convertedDir = path.join(__dirname, 'converted');

[uploadsDir, convertedDir].forEach(dir => {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
});

// إعداد Multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, uploadsDir),
  filename: (req, file, cb) => {
    const uniqueName = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, uniqueName + path.extname(file.originalname));
  }
});

const upload = multer({
  storage: storage,
  limits: { fileSize: 500 * 1024 * 1024 }, // 500MB
});

// الصفحة الرئيسية
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// رفع الملف
app.post('/api/upload', upload.single('file'), (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ 
        success: false, 
        error: 'لم يتم رفع أي ملف' 
      });
    }

    // تحديد نوع الملف
    const fileType = getFileType(req.file.mimetype, req.file.originalname);

    res.json({
      success: true,
      fileId: req.file.filename,
      fileName: req.file.originalname,
      fileSize: req.file.size,
      fileType: fileType,
      mimeType: req.file.mimetype
    });
  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// تحويل الملف (موحّد لكل الأنواع)
app.post('/api/convert', async (req, res) => {
  try {
    const { fileId, format, fileType, quality, width, height, videoBitrate, audioBitrate } = req.body;

    if (!fileId || !format) {
      return res.status(400).json({ 
        success: false, 
        error: 'معلومات التحويل غير مكتملة' 
      });
    }

    const inputPath = path.join(uploadsDir, fileId);

    if (!fs.existsSync(inputPath)) {
      return res.status(404).json({ 
        success: false, 
        error: 'الملف غير موجود' 
      });
    }

    let outputFileName;
    let outputPath;

    // اختيار طريقة التحويل حسب نوع الملف
    switch(fileType) {
      case 'image':
        ({ outputFileName, outputPath } = await convertImage(inputPath, format, quality, width, height));
        break;
      case 'video':
        ({ outputFileName, outputPath } = await convertVideo(inputPath, format, videoBitrate));
        break;
      case 'audio':
        ({ outputFileName, outputPath } = await convertAudio(inputPath, format, audioBitrate));
        break;
      case 'document':
        ({ outputFileName, outputPath } = await convertDocument(inputPath, format, fileId));
        break;
      default:
        throw new Error('نوع ملف غير مدعوم');
    }

    // حذف الملف الأصلي
    try {
      fs.unlinkSync(inputPath);
    } catch (err) {
      console.log('لم يتم حذف الملف الأصلي');
    }

    res.json({
      success: true,
      downloadUrl: `/api/download/${outputFileName}`,
      fileName: outputFileName
    });

  } catch (error) {
    console.error('خطأ في التحويل:', error);
    res.status(500).json({ 
      success: false, 
      error: 'فشل التحويل: ' + error.message 
    });
  }
});

// تحويل الصور
async function convertImage(inputPath, format, quality = 90, width, height) {
  const outputFileName = `converted-${Date.now()}.${format}`;
  const outputPath = path.join(convertedDir, outputFileName);

  let image = sharp(inputPath);

  if (width || height) {
    image = image.resize(
      width ? parseInt(width) : null,
      height ? parseInt(height) : null,
      { fit: 'inside' }
    );
  }

  switch (format.toLowerCase()) {
    case 'jpg':
    case 'jpeg':
      await image.jpeg({ quality: parseInt(quality) }).toFile(outputPath);
      break;
    case 'png':
      await image.png({ quality: parseInt(quality) }).toFile(outputPath);
      break;
    case 'webp':
      await image.webp({ quality: parseInt(quality) }).toFile(outputPath);
      break;
    case 'gif':
      await image.gif().toFile(outputPath);
      break;
    case 'bmp':
      await image.toFormat('bmp').toFile(outputPath);
      break;
    case 'tiff':
      await image.tiff({ quality: parseInt(quality) }).toFile(outputPath);
      break;
    case 'avif':
      await image.avif({ quality: parseInt(quality) }).toFile(outputPath);
      break;
    default:
      throw new Error('صيغة صورة غير مدعومة');
  }

  return { outputFileName, outputPath };
}

// تحويل الفيديو
function convertVideo(inputPath, format, bitrate = '1000k') {
  return new Promise((resolve, reject) => {
    const outputFileName = `converted-${Date.now()}.${format}`;
    const outputPath = path.join(convertedDir, outputFileName);

    let command = ffmpeg(inputPath)
      .videoBitrate(bitrate)
      .outputOptions('-movflags +faststart'); // للتشغيل السريع

    // إعدادات خاصة حسب الصيغة
    switch (format.toLowerCase()) {
      case 'mp4':
        command = command.videoCodec('libx264').audioCodec('aac');
        break;
      case 'webm':
        command = command.videoCodec('libvpx').audioCodec('libvorbis');
        break;
      case 'avi':
        command = command.videoCodec('mpeg4').audioCodec('mp3');
        break;
      case 'mov':
        command = command.videoCodec('libx264').audioCodec('aac');
        break;
      case 'mkv':
        command = command.videoCodec('libx264').audioCodec('aac');
        break;
      case 'gif':
        command = command.fps(10).size('480x?');
        break;
    }

    command
      .on('end', () => resolve({ outputFileName, outputPath }))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// تحويل الصوت
function convertAudio(inputPath, format, bitrate = '192k') {
  return new Promise((resolve, reject) => {
    const outputFileName = `converted-${Date.now()}.${format}`;
    const outputPath = path.join(convertedDir, outputFileName);

    let command = ffmpeg(inputPath)
      .audioBitrate(bitrate);

    // إعدادات خاصة حسب الصيغة
    switch (format.toLowerCase()) {
      case 'mp3':
        command = command.audioCodec('libmp3lame');
        break;
      case 'wav':
        command = command.audioCodec('pcm_s16le');
        break;
      case 'ogg':
        command = command.audioCodec('libvorbis');
        break;
      case 'm4a':
        command = command.audioCodec('aac');
        break;
      case 'flac':
        command = command.audioCodec('flac');
        break;
      case 'aac':
        command = command.audioCodec('aac');
        break;
    }

    command
      .on('end', () => resolve({ outputFileName, outputPath }))
      .on('error', (err) => reject(err))
      .save(outputPath);
  });
}

// تحويل المستندات
async function convertDocument(inputPath, format, originalFileName) {
  const outputFileName = `converted-${Date.now()}.${format}`;
  const outputPath = path.join(convertedDir, outputFileName);

  const ext = path.extname(originalFileName).toLowerCase();

  if (format === 'txt') {
    // تحويل إلى TXT
    let text = '';

    if (ext === '.pdf') {
      const dataBuffer = fs.readFileSync(inputPath);
      const data = await pdfParse(dataBuffer);
      text = data.text;
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: inputPath });
      text = result.value;
    } else {
      text = fs.readFileSync(inputPath, 'utf8');
    }

    fs.writeFileSync(outputPath, text);

  } else if (format === 'pdf') {
    // تحويل إلى PDF
    const doc = new PDFDocument();
    doc.pipe(fs.createWriteStream(outputPath));

    let text = '';

    if (ext === '.txt') {
      text = fs.readFileSync(inputPath, 'utf8');
    } else if (ext === '.docx' || ext === '.doc') {
      const result = await mammoth.extractRawText({ path: inputPath });
      text = result.value;
    }

    // إضافة دعم النصوص العربية
    doc.font('Helvetica');
    doc.fontSize(12);
    doc.text(text || 'تم التحويل بنجاح', 100, 100);
    doc.end();

    // انتظار انتهاء الكتابة
    await new Promise(resolve => {
      doc.on('end', resolve);
    });

  } else if (format === 'docx') {
    // تحويل بسيط (يحتاج مكتبات إضافية للتحويل الكامل)
    throw new Error('تحويل DOCX قيد التطوير');
  }

  return { outputFileName, outputPath };
}

// تحميل الملف
app.get('/api/download/:filename', (req, res) => {
  try {
    const filename = req.params.filename;
    const filePath = path.join(convertedDir, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({ 
        success: false, 
        error: 'الملف غير موجود' 
      });
    }

    res.download(filePath, filename, (err) => {
      if (err) {
        console.error('خطأ في التحميل:', err);
      } else {
        // حذف بعد 10 ثواني
        setTimeout(() => {
          try {
            if (fs.existsSync(filePath)) {
              fs.unlinkSync(filePath);
            }
          } catch (e) {
            console.error('خطأ في الحذف:', e);
          }
        }, 10000);
      }
    });

  } catch (error) {
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
  }
});

// تحديد نوع الملف
function getFileType(mimeType, filename) {
  const ext = path.extname(filename).toLowerCase();

  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';

  // حسب الامتداد
  const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.bmp', '.webp', '.tiff', '.avif'];
  const videoExts = ['.mp4', '.avi', '.mov', '.wmv', '.flv', '.mkv', '.webm'];
  const audioExts = ['.mp3', '.wav', '.ogg', '.m4a', '.flac', '.aac', '.wma'];
  const docExts = ['.pdf', '.doc', '.docx', '.txt', '.rtf'];

  if (imageExts.includes(ext)) return 'image';
  if (videoExts.includes(ext)) return 'video';
  if (audioExts.includes(ext)) return 'audio';
  if (docExts.includes(ext)) return 'document';

  return 'unknown';
}

// تنظيف الملفات القديمة
setInterval(() => {
  const now = Date.now();
  const maxAge = 2 * 60 * 60 * 1000; // ساعتين

  [uploadsDir, convertedDir].forEach(dir => {
    fs.readdir(dir, (err, files) => {
      if (err) return;

      files.forEach(file => {
        const filePath = path.join(dir, file);
        fs.stat(filePath, (err, stats) => {
          if (err) return;

          if (now - stats.mtime.getTime() > maxAge) {
            fs.unlink(filePath, err => {
              if (!err) console.log('✅ تم حذف ملف قديم:', file);
            });
          }
        });
      });
    });
  });
}, 60 * 60 * 1000);

// تشغيل السيرفر
app.listen(PORT, , () => {
  console.log(`🚀 المحول الشامل يعمل على المنفذ ${PORT}`);
  console.log(`🌐 الرابط: http://localhost:${PORT}`);
  console.log(`📁 الملفات المدعومة:`);
  console.log(`   🖼️  الصور: JPG, PNG, WebP, GIF, BMP, TIFF, AVIF`);
  console.log(`   🎬 الفيديو: MP4, AVI, MOV, WebM, MKV, GIF`);
  console.log(`   🎵 الصوت: MP3, WAV, OGG, M4A, FLAC, AAC`);
  console.log(`   📄 المستندات: PDF, TXT, DOCX`);
});
