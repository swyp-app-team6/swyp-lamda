pipeline {
    agent any

    environment {
        SLACK_CHANNEL = "#6팀-PR"
        AWS_REGION    = "ap-northeast-2"
    }

    triggers {
        githubPush()
    }

    stages {
        stage('Checkout') {
            steps {
                checkout scm
            }
        }

        stage('Deploy thumbnail Lambda') {
            when {
                changeset "functions/thumbnail/**"
            }
            steps {
                echo 'Deploying thumbnail Lambda...'
                dir('functions/thumbnail') {
                    sh 'npm install'
                    sh 'zip -r function.zip index.js node_modules package.json'
                    withCredentials([[$class: 'AmazonWebServicesCredentialsBinding', credentialsId: 'aws-lambda-deploy']]) {
                        sh """
                            aws lambda update-function-code \
                                --function-name swiipe-thumbnail-lambda \
                                --zip-file fileb://function.zip \
                                --region ${AWS_REGION}
                        """
                    }
                    sh 'rm -f function.zip'
                }
            }
        }
    }

    post {
        success {
            echo 'Pipeline successfully completed!'
            slackSend(
                channel: SLACK_CHANNEL,
                color: '#2C953C',
                message: ":white_check_mark: ${env.JOB_NAME} 배포 성공! (빌드 #${env.BUILD_NUMBER})\n${env.BUILD_URL}"
            )
        }
        failure {
            echo 'Pipeline failed. Please check the logs.'
            slackSend(
                channel: SLACK_CHANNEL,
                color: '#FF3232',
                message: ":x: ${env.JOB_NAME} 배포 실패! (빌드 #${env.BUILD_NUMBER})\n${env.BUILD_URL}"
            )
        }
    }
}
