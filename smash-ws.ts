import { Surreal } from './mod.ts';

let conns = []
for (let i = 0; i < 1000; i++) {
	console.log(`Iteration ${i}`);
	const db = new Surreal();
	await db.connect('ws://localhost:8000/rpc');
	await db.signin({ user: 'root', pass: 'root' });
	await db.use({ ns: 'test', db: 'test' });
	conns[i] = db
}
console.log("Finished")

//const queryId = await db.live('live select * from test', (data) => {
//	console.log(data);
//});
//
//setInterval(() => {
//	db.create('test')
//}, 1000);
