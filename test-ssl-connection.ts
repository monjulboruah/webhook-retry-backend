import https from 'https';
import axios from 'axios';

/**
 * Test script to verify SSL/TLS connection to Azure App Service
 * Run with: npx ts-node test-ssl-connection.ts
 */

// Replace with your actual Azure App Service URL
const AZURE_TARGET_URL = process.env.AZURE_TARGET_URL || 'https://your-app.azurewebsites.net/api/webhook';

console.log('🔐 Testing SSL/TLS Connection to Azure App Service\n');
console.log(`Target URL: ${AZURE_TARGET_URL}\n`);

// Test 1: With rejectUnauthorized: true (SECURE)
async function testSecureConnection() {
    console.log('Test 1: Secure Connection (rejectUnauthorized: true)');
    console.log('─'.repeat(60));

    const httpsAgent = new https.Agent({
        keepAlive: true,
        maxSockets: 100,
        rejectUnauthorized: true  // ✅ Proper SSL validation
    });

    try {
        const response = await axios.post(AZURE_TARGET_URL,
            { test: 'data', timestamp: new Date().toISOString() },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'WebhookRetryWorker/1.0',
                    'Accept': 'application/json'
                },
                httpsAgent,
                timeout: 10000,
                validateStatus: () => true // Accept any status code for testing
            }
        );

        console.log('✅ SUCCESS - SSL connection established');
        console.log(`   Status: ${response.status} ${response.statusText}`);
        console.log(`   Response: ${JSON.stringify(response.data).substring(0, 100)}`);
        return true;
    } catch (error: any) {
        console.log('❌ FAILED - SSL connection error');

        if (error.code === 'SELF_SIGNED_CERT_IN_CHAIN') {
            console.log('   Error: Self-signed certificate in chain');
            console.log('   Solution: Add the CA certificate to the agent');
        } else if (error.code === 'UNABLE_TO_VERIFY_LEAF_SIGNATURE') {
            console.log('   Error: Unable to verify certificate');
            console.log('   Solution: Check certificate chain on Azure');
        } else if (error.code === 'CERT_HAS_EXPIRED') {
            console.log('   Error: Certificate has expired');
            console.log('   Solution: Renew certificate on Azure');
        } else if (error.code === 'ERR_TLS_CERT_ALTNAME_INVALID') {
            console.log('   Error: Hostname does not match certificate');
            console.log('   Solution: Ensure URL matches certificate CN/SAN');
        } else {
            console.log(`   Error: ${error.message}`);
            console.log(`   Code: ${error.code || 'N/A'}`);
        }

        console.log('\n   Full error details:');
        console.log('   ', error);
        return false;
    }
}

// Test 2: Get certificate information
async function getCertificateInfo() {
    console.log('\n\nTest 2: Certificate Information');
    console.log('─'.repeat(60));

    return new Promise((resolve) => {
        try {
            const url = new URL(AZURE_TARGET_URL);

            const req = https.request({
                hostname: url.hostname,
                port: 443,
                path: '/',
                method: 'GET',
                rejectUnauthorized: true
            }, (res) => {
                const cert = (res.socket as any).getPeerCertificate();

                if (cert && Object.keys(cert).length > 0) {
                    console.log('✅ Certificate Details:');
                    console.log(`   Subject: ${cert.subject?.CN || 'N/A'}`);
                    console.log(`   Issuer: ${cert.issuer?.CN || 'N/A'}`);
                    console.log(`   Valid From: ${cert.valid_from}`);
                    console.log(`   Valid To: ${cert.valid_to}`);
                    console.log(`   Serial Number: ${cert.serialNumber}`);

                    if (cert.subjectaltname) {
                        console.log(`   Alt Names: ${cert.subjectaltname}`);
                    }

                    // Check if expired
                    const now = new Date();
                    const validTo = new Date(cert.valid_to);
                    if (validTo < now) {
                        console.log('   ⚠️  WARNING: Certificate has EXPIRED!');
                    } else {
                        const daysUntilExpiry = Math.floor((validTo.getTime() - now.getTime()) / (1000 * 60 * 60 * 24));
                        console.log(`   ✅ Certificate valid for ${daysUntilExpiry} more days`);
                    }
                } else {
                    console.log('❌ No certificate information available');
                }

                resolve(true);
            });

            req.on('error', (error: any) => {
                console.log('❌ Failed to retrieve certificate');
                console.log(`   Error: ${error.message}`);
                resolve(false);
            });

            req.end();
        } catch (error: any) {
            console.log('❌ Failed to parse URL or connect');
            console.log(`   Error: ${error.message}`);
            resolve(false);
        }
    });
}

// Test 3: Compare with insecure connection (for debugging only)
async function testInsecureConnection() {
    console.log('\n\nTest 3: Insecure Connection (rejectUnauthorized: false)');
    console.log('─'.repeat(60));
    console.log('⚠️  This is for debugging only - DO NOT use in production!\n');

    const httpsAgent = new https.Agent({
        keepAlive: true,
        maxSockets: 100,
        rejectUnauthorized: false  // ❌ Insecure - for testing only
    });

    try {
        const response = await axios.post(AZURE_TARGET_URL,
            { test: 'data', timestamp: new Date().toISOString() },
            {
                headers: {
                    'Content-Type': 'application/json',
                    'User-Agent': 'WebhookRetryWorker/1.0'
                },
                httpsAgent,
                timeout: 10000,
                validateStatus: () => true
            }
        );

        console.log('✅ Connection successful (but insecure)');
        console.log(`   Status: ${response.status} ${response.statusText}`);
        console.log('\n   If this works but Test 1 fails, you have a certificate issue.');
        return true;
    } catch (error: any) {
        console.log('❌ Connection failed even with insecure mode');
        console.log(`   Error: ${error.message}`);
        console.log('\n   This suggests a network/routing issue, not a certificate issue.');
        return false;
    }
}

// Run all tests
async function runAllTests() {
    const secureResult = await testSecureConnection();
    await getCertificateInfo();
    await testInsecureConnection();

    console.log('\n\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));

    if (secureResult) {
        console.log('✅ Your Azure App Service has a valid SSL certificate');
        console.log('✅ rejectUnauthorized: true is SAFE to use');
        console.log('✅ No additional changes needed!');
    } else {
        console.log('❌ SSL validation failed');
        console.log('📋 Review the error details above to determine next steps');
        console.log('💡 Common solutions:');
        console.log('   1. Ensure Azure certificate is valid and not expired');
        console.log('   2. Check that URL hostname matches certificate');
        console.log('   3. Verify certificate chain is complete');
        console.log('   4. Add custom CA if using self-signed certificates');
    }

    console.log('\n');
}

runAllTests().catch(console.error);
