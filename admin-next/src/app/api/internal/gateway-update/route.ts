import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { gatewayPort } = body;
        const gatewaySecretHeader = req.headers.get('x-gateway-secret');

        // Security check: Match gateway secret
        let configPath = path.resolve(process.cwd(), 'wordjs-config.json');
        if (!fs.existsSync(configPath)) {
            configPath = path.resolve(process.cwd(), '../backend/wordjs-config.json');
        }

        if (!fs.existsSync(configPath)) {
            return NextResponse.json({ error: 'Config not found' }, { status: 500 });
        }

        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));

        if (gatewaySecretHeader !== config.gatewaySecret) {
            return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
        }

        // Update the config file
        config.gatewayPort = gatewayPort;
        fs.writeFileSync(configPath, JSON.stringify(config, null, 2));

        console.log(`🔄 [Frontend] Gateway Migration: Port updated to ${gatewayPort}`);

        return NextResponse.json({ success: true, message: 'Frontend config updated' });
    } catch (e: any) {
        return NextResponse.json({ error: e.message }, { status: 500 });
    }
}
