const express = require('express');
const mongoose = require('mongoose');
const LmsItem = require('../models/LmsItem');
const Course = require('../models/Course');
const User = require('../models/User');
const { protect } = require('../middleware/auth');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const router = express.Router();
const TYPES = new Set(['classes','assignments','submissions','files','messages','notifications','todos','announcements','certificates','audit-logs','sessions','system-settings']);
const role = u => u.role === 'faculty' ? 'instructor' : u.role;
async function accessibleCourses(user) {
  if (role(user) === 'admin') return null;
  if (role(user) === 'instructor') return (await Course.find({faculty:user._id}).select('_id')).map(x=>x._id);
  return (await Course.find({students:user._id}).select('_id')).map(x=>x._id);
}
router.use(protect);
const uploadDir = path.join(__dirname, '..', 'uploads', 'library');
fs.mkdirSync(uploadDir, { recursive: true });
const allowedExtensions = new Set(['.pdf', '.doc', '.docx', '.ppt', '.pptx', '.xls', '.xlsx', '.txt', '.png', '.jpg', '.jpeg', '.mp4', '.zip']);
const upload = multer({
  storage: multer.diskStorage({ destination: uploadDir, filename: (req, file, cb) => cb(null, `${Date.now()}-${require('crypto').randomBytes(8).toString('hex')}${path.extname(file.originalname).toLowerCase()}`) }),
  limits: { fileSize: 20 * 1024 * 1024 },
  fileFilter: (req, file, cb) => allowedExtensions.has(path.extname(file.originalname).toLowerCase()) ? cb(null, true) : cb(Object.assign(new Error('This file type is not supported.'), { status: 400 }))
});
const parseUpload=(req,res,next)=>upload.single('file')(req,res,error=>{if(!error)return next();const status=error.code==='LIMIT_FILE_SIZE'?413:(error.status||400);return res.status(status).json({success:false,message:error.code==='LIMIT_FILE_SIZE'?'Files must be 20 MB or smaller.':error.message||'Could not upload this file.'})});
router.post('/files/upload', parseUpload, async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ success:false, message:'Choose a file to upload.' });
    const item = await LmsItem.create({ type:'files', owner:req.user._id, data:{ name:path.basename(req.file.originalname).slice(0,180), storedName:req.file.filename, mimeType:req.file.mimetype, size:req.file.size, category:String(req.body.category||'Personal file').slice(0,60) } });
    res.status(201).json({ success:true, data:{...item.toObject(), id:item._id} });
  } catch(e){ next(e); }
});
router.post('/submissions/upload', parseUpload, async(req,res,next)=>{
  try{
    const {assignmentId,notes=''}=req.body;if(!req.file)return res.status(400).json({success:false,message:'Choose the file you want to submit.'});
    if(role(req.user)!=='student')return res.status(403).json({success:false,message:'Only learners can submit assignment work.'});
    if(!mongoose.isValidObjectId(assignmentId))return res.status(400).json({success:false,message:'Choose a valid assignment.'});
    const assignment=await LmsItem.findOne({_id:assignmentId,type:'assignments','data.status':'published'});if(!assignment)return res.status(404).json({success:false,message:'This assignment is not open for submissions.'});
    const course=await Course.findById(assignment.course);if(!course||!course.students.some(id=>String(id)===String(req.user._id)))return res.status(403).json({success:false,message:'You are not enrolled in this course.'});
    const prior=await LmsItem.findOne({type:'submissions',owner:req.user._id,'data.assignmentId':String(assignment._id)});if(prior)return res.status(409).json({success:false,message:'You have already submitted work for this assignment.'});
    const item=await LmsItem.create({type:'submissions',owner:req.user._id,course:course._id,data:{assignmentId:String(assignment._id),assignmentTitle:assignment.data.title,courseName:course.title,maxGrade:Number(assignment.data.maxGrade||100),storedName:req.file.filename,fileName:path.basename(req.file.originalname).slice(0,180),fileSize:req.file.size,notes:String(notes).slice(0,5000),submittedAt:new Date(),status:'submitted'}});
    await LmsItem.create({type:'notifications',owner:course.faculty,data:{type:'assignment',title:'New assignment submission',message:`A learner submitted work for ${assignment.data.title}.`,entityId:String(item._id)}});
    res.status(201).json({success:true,data:item});
  }catch(e){next(e)}
});
router.get('/submissions/:id/file',async(req,res,next)=>{
  try{
    const item=await LmsItem.findOne({_id:req.params.id,type:'submissions'});if(!item||!item.data.storedName)return res.status(404).json({success:false,message:'Submission file not found.'});
    const r=role(req.user),owner=String(item.owner)===String(req.user._id);let permitted=owner||r==='admin';
    if(r==='instructor'&&item.course){const course=await Course.findById(item.course);permitted=permitted||String(course?.faculty)===String(req.user._id)}
    if(!permitted)return res.status(403).json({success:false,message:'You do not have access to this submission.'});
    const filename=path.basename(item.data.storedName);const target=path.join(uploadDir,filename);if(!fs.existsSync(target))return res.status(404).json({success:false,message:'Submission file is no longer available.'});
    res.download(target,item.data.fileName||'assignment-submission');
  }catch(e){next(e)}
});
router.get('/files/:id/download', async(req,res,next)=>{
  try {
    const file=await LmsItem.findOne({_id:req.params.id,type:'files'});
    if(!file)return res.status(404).json({success:false,message:'File not found.'});
    const r=role(req.user);let allowed=String(file.owner)===String(req.user._id)||r==='admin';
    if(r==='instructor'&&file.course){const c=await Course.findById(file.course);allowed=allowed||String(c?.faculty)===String(req.user._id)}
    if(!allowed)return res.status(403).json({success:false,message:'You do not have access to this file.'});
    const target=path.join(uploadDir,path.basename(file.data.storedName||''));
    if(!fs.existsSync(target))return res.status(404).json({success:false,message:'This file is no longer available.'});
    res.download(target,file.data.name||'LearnPool-file');
  }catch(e){next(e)}
});
router.get('/:type', async (req,res,next) => {
 try {
  const {type}=req.params; if(!TYPES.has(type)) return res.status(404).json({success:false,message:'Unknown resource'});
  const user=req.user, r=role(user); let q={type};
  if(type==='messages') q.$or=[{owner:user._id},{recipients:user._id}];
  else if(type==='notifications'||type==='todos'||type==='sessions') q.owner=user._id;
  else if(type==='audit-logs'||type==='system-settings') { if(r!=='admin') return res.status(403).json({success:false,message:'Admin access required'}); }
  else if(type==='files') { if(r==='admin')q={type};else q.$or=[{owner:user._id},{course:{$in:await accessibleCourses(user)}}]; }
  else if(type==='certificates') { if(r==='student') q.owner=user._id;else if(r==='instructor')q={'data.courseId':{$in:(await accessibleCourses(user)||[]).map(String)}}; }
  else if(type==='announcements') { if(r==='admin')q={type};else q={type,$or:[{owner:user._id},{'data.audience':'all'},{'data.audience':r}]}; }
  else if(r==='student') q={type,$or:[{owner:user._id},{course:{$in:await accessibleCourses(user)}},{recipients:user._id}], ...(type==='assignments'?{'data.status':{$in:['published','open']}}:{})};
  else if(r==='instructor') q={type,$or:[{owner:user._id},{course:{$in:await accessibleCourses(user)}}]};
  const items=await LmsItem.find(q).sort({createdAt:-1}).limit(Math.min(Number(req.query.limit)||100,200)).lean();
  res.json({success:true,data:items.map(x=>({...x,id:x._id}))});
 } catch(e){next(e)}
});
router.post('/:type', async(req,res,next)=>{
 try {
  const {type}=req.params; if(!TYPES.has(type)) return res.status(404).json({success:false,message:'Unknown resource'});
  const user=req.user,r=role(user), body=req.body||{};
  if(type==='files')return res.status(400).json({success:false,message:'Use the validated file upload endpoint.'});
  if(['audit-logs','notifications','system-settings'].includes(type)&&r!=='admin') return res.status(403).json({success:false,message:'Not authorized'});
  if(type==='announcements'&&r!=='admin') return res.status(403).json({success:false,message:'Admin access required'});
  if(['classes','assignments'].includes(type)&&!['instructor','admin'].includes(r)) return res.status(403).json({success:false,message:'Instructor access required'});
  if(type==='certificates'&&r!=='admin') return res.status(403).json({success:false,message:'Admin access required'});
  if(type==='submissions'){
    if(r!=='student')return res.status(403).json({success:false,message:'Only learners can submit assignment work.'});
    if(!mongoose.isValidObjectId(body.assignmentId))return res.status(400).json({success:false,message:'Choose a valid assignment.'});
    const assignment=await LmsItem.findOne({_id:body.assignmentId,type:'assignments','data.status':'published'});
    if(!assignment)return res.status(404).json({success:false,message:'This assignment is not open for submissions.'});
    const course=await Course.findById(assignment.course);
    if(!course||!course.students.some(id=>String(id)===String(user._id)))return res.status(403).json({success:false,message:'You are not enrolled in this course.'});
    const prior=await LmsItem.findOne({type:'submissions',owner:user._id,'data.assignmentId':String(assignment._id)});
    if(prior)return res.status(409).json({success:false,message:'You have already submitted work for this assignment.'});
    let submissionUrl='';try{const url=new URL(String(body.submissionUrl||''));if(['http:','https:'].includes(url.protocol))submissionUrl=url.toString()}catch{}
    if(!submissionUrl)return res.status(400).json({success:false,message:'Add a valid HTTP(S) link or upload a file.'});
    const item=await LmsItem.create({type,owner:user._id,course:course._id,data:{assignmentId:String(assignment._id),assignmentTitle:assignment.data.title,courseName:course.title,maxGrade:Number(assignment.data.maxGrade||100),submissionUrl,notes:String(body.notes||'').slice(0,5000),submittedAt:new Date(),status:'submitted'}});
    await LmsItem.create({type:'notifications',owner:course.faculty,data:{type:'assignment',title:'New assignment submission',message:`A learner submitted work for ${assignment.data.title}.`,entityId:String(item._id)}});
    return res.status(201).json({success:true,data:{...item.toObject(),id:item._id}});
  }
  const data={...body};
  if(type==='messages') {
    const recipient=await User.findOne({email:String(body.recipientEmail||'').toLowerCase().trim()}).select('name email preferences');
    if(!recipient)return res.status(404).json({success:false,message:'No LearnPool account was found for that email.'});
    if(String(recipient._id)===String(user._id))return res.status(400).json({success:false,message:'Choose someone else to message.'});
    data.senderName=user.name;data.recipientName=recipient.name;data.content=String(body.content||'').slice(0,5000);data.subject=String(body.subject||'').slice(0,160);
    if(!data.content||!data.subject)return res.status(400).json({success:false,message:'Subject and message are required.'});
    const item=await LmsItem.create({type,owner:user._id,recipients:[recipient._id],data});
    if(recipient.preferences?.messageNotifications!==false)await LmsItem.create({type:'notifications',owner:recipient._id,data:{type:'message',title:`New message from ${user.name}`,message:data.subject,entityId:String(item._id)}});
    return res.status(201).json({success:true,data:{...item.toObject(),id:item._id}});
  }
  if(type==='assignments') { if(!data.title||!data.course) return res.status(400).json({success:false,message:'Title and course are required'}); data.status=data.status==='published'?'published':'draft';data.maxGrade=Math.max(1,Math.min(1000,Number(data.maxGrade)||100));if(data.dueDate&&!Number.isFinite(Date.parse(data.dueDate)))return res.status(400).json({success:false,message:'Enter a valid due date.'}); }
  if(type==='classes') {
    if(!data.title||!data.course||!data.startTime||!Number.isFinite(Date.parse(data.startTime)))return res.status(400).json({success:false,message:'Title, course and a valid start time are required.'});
    for(const key of ['meetingLink','recordingUrl'])if(data[key]){try{const url=new URL(data[key]);if(!['http:','https:'].includes(url.protocol))throw new Error()}catch{return res.status(400).json({success:false,message:'Meeting and recording links must use HTTP or HTTPS.'})}}
    if(data.endTime&&(!Number.isFinite(Date.parse(data.endTime))||Date.parse(data.endTime)<=Date.parse(data.startTime)))return res.status(400).json({success:false,message:'Class end time must be after it starts.'});
  }
  if(type==='todos'&&!data.title) return res.status(400).json({success:false,message:'Title is required'});
  let course=null;
  if(data.course){ if(!mongoose.isValidObjectId(data.course)) return res.status(400).json({success:false,message:'Invalid course'}); course=await Course.findById(data.course); if(!course) return res.status(404).json({success:false,message:'Course not found'}); if(r==='instructor'&&String(course.faculty)!==String(user._id)) return res.status(403).json({success:false,message:'Course is outside your teaching access'});data.courseName=course.title; }
  const item=await LmsItem.create({type,owner:user._id,course:course?course._id:null,data,recipients:Array.isArray(body.recipients)?body.recipients:[]});
  if(type==='assignments'&&data.status==='published'&&course){
    const learners=await User.find({_id:{$in:course.students},'preferences.assignmentNotifications':{$ne:false}}).select('_id');
    if(learners.length)await LmsItem.insertMany(learners.map(learner=>({type:'notifications',owner:learner._id,data:{type:'assignment',title:'New assignment',message:`${data.title} is ready in ${course.title}.`,entityId:String(item._id)}})));
  }
  if(type==='announcements'){
    const audience=data.audience==='student'?'student':data.audience==='instructor'?{$in:['faculty','instructor']}:{$in:['student','faculty','instructor']};
    const audienceUsers=await User.find({role:audience,status:'active','preferences.announcementNotifications':{$ne:false}}).select('_id');
    if(audienceUsers.length)await LmsItem.insertMany(audienceUsers.map(person=>({type:'notifications',owner:person._id,data:{type:'announcement',title:data.title,message:String(data.body||'').slice(0,300),entityId:String(item._id)}})));
  }
  if(['classes','assignments','announcements'].includes(type)){
    await LmsItem.create({type:'audit-logs',owner:user._id,data:{action:type+'.created',entityId:String(item._id),title:String(data.title||'').slice(0,120)}});
  }
  if(type==='audit-logs') await item.populate('owner','name email');
  res.status(201).json({success:true,data:{...item.toObject(),id:item._id}});
 }catch(e){next(e)}
});
router.patch('/:type/:id',async(req,res,next)=>{
 try{
  const {type,id}=req.params;if(!TYPES.has(type))return res.status(404).json({success:false,message:'Unknown resource'});
  const item=await LmsItem.findOne({_id:id,type});if(!item)return res.status(404).json({success:false,message:'Record not found'});
  const r=role(req.user); const owner=String(item.owner)===String(req.user._id); let allowed=owner||r==='admin';
  if(type==='messages'&&item.recipients.some(id=>String(id)===String(req.user._id)))allowed=true;
  if(type==='audit-logs'||type==='certificates')return res.status(403).json({success:false,message:'This record cannot be edited.'});
  if((type==='audit-logs'||type==='system-settings')&&r!=='admin')return res.status(403).json({success:false,message:'Admin access required'});
  if(r==='student'&&type==='submissions')return res.status(403).json({success:false,message:'Submitted work cannot be changed here.'});
  if(type==='files')return res.status(403).json({success:false,message:'Files are immutable after upload.'});
  if(r==='instructor'&&item.course){const c=await Course.findById(item.course);allowed=allowed||String(c?.faculty)===String(req.user._id)}
  if(type==='submissions'&&r==='student')allowed=owner;
  if(!allowed)return res.status(403).json({success:false,message:'Not authorized'});
  if(type==='assignments'&&r==='student')return res.status(403).json({success:false,message:'Students cannot edit assignments'});
  if(type==='submissions'&&r==='instructor'&&('grade'in req.body||'feedback'in req.body)){
    const grade=Number(req.body.grade);
    if(!Number.isFinite(grade)||grade<0||grade>Number(item.data.maxGrade||100))return res.status(400).json({success:false,message:'Enter a valid score for this assignment.'});
    item.data.grade=grade;item.data.feedback=String(req.body.feedback||'').slice(0,5000);item.data.gradedAt=new Date();item.data.status='graded';
    await LmsItem.create({type:'notifications',owner:item.owner,data:{type:'assignment',title:'Assignment graded',message:`Your work for ${item.data.assignmentTitle} has been graded.`,entityId:String(item._id)}});
  } else if(type==='todos'&&owner) item.data={...item.data,completed:!!req.body.completed};
  else if(type==='notifications'&&owner){if(req.body.read===true)item.readAt=new Date();if(req.body.read===false)item.readAt=null;}
  else if(type==='messages'){if(req.body.read===true)item.readAt=new Date();if(req.body.read===false)item.readAt=null;}
  else item.data={...item.data,...req.body};
  if(type==='system-settings')await LmsItem.create({type:'audit-logs',owner:req.user._id,data:{action:'system-setting.updated',entityId:String(item._id),key:item.data.settingKey}});
  if(req.body.read===true)item.readAt=new Date(); if(req.body.read===false)item.readAt=null;
  await item.save();res.json({success:true,data:{...item.toObject(),id:item._id}})
 }catch(e){next(e)}
});
router.delete('/:type/:id',async(req,res,next)=>{
 try{
  const {type,id}=req.params;const item=await LmsItem.findOne({_id:id,type});if(!item)return res.status(404).json({success:false,message:'Record not found'});
  const r=role(req.user);let allowed=String(item.owner)===String(req.user._id)||r==='admin';
  if(r==='instructor'&&item.course){const course=await Course.findById(item.course);allowed=allowed||String(course?.faculty)===String(req.user._id)}
  if(['audit-logs','certificates','submissions'].includes(type))return res.status(403).json({success:false,message:'This record cannot be deleted. Use its managed status instead.'});
  if(!allowed)return res.status(403).json({success:false,message:'Not authorized'});
  if(type==='files'&&item.data.storedName){const target=path.join(uploadDir,path.basename(item.data.storedName));if(fs.existsSync(target))fs.unlinkSync(target)}
  await item.deleteOne();res.json({success:true})
 }catch(e){next(e)}
});
module.exports=router;
