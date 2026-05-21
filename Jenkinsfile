pipeline {
    agent any

    environment {
        CLOUDFLARE_API_TOKEN  = credentials('cloudflare-api-token')
        CLOUDFLARE_ACCOUNT_ID = credentials('cloudflare-account-id')
        SLACK_WEBHOOK         = credentials('slack-webhook')
    }

    triggers {
        pollSCM('* * * * *')
    }

    stages {
        stage('Checkout') {
            steps { checkout scm }
        }

        stage('Install') {
            steps { sh 'npm ci' }
        }

        stage('Deploy Worker') {
            steps { sh 'npx wrangler deploy' }
        }

        stage('Smoke Test') {
            steps {
                script {
                    sleep(5)
                    def code = sh(script: 'curl -s -o /dev/null -w "%{http_code}" --max-time 10 https://api.galsaril.com/health', returnStdout: true).trim()
                    if (code != '200') error("Smoke test failed: HTTP ${code}")
                }
            }
        }
    }

    post {
        success { sh """curl -s -X POST "${SLACK_WEBHOOK}" -H "Content-Type: application/json" --data '{"text":":white_check_mark: *worker-deploy* passed — api.galsaril.com is live."}'""" }
        failure { sh """curl -s -X POST "${SLACK_WEBHOOK}" -H "Content-Type: application/json" --data '{"text":":red_circle: *worker-deploy* FAILED — check Jenkins: http://localhost:8081/job/worker-deploy/"}'""" }
    }
}
